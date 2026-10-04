import type { Env, Fetch } from './env';
import { log } from './log';
import { checkPeople, type CheckTotals } from './check';
import { markWork, REQUEUE_MS, runWork, type WorkOutcome } from './work';

/**
 * The cron, every minute: the people due this minute, checked a few at a time, each few in its own
 * invocation of this Worker (`env.SELF.check`, a service binding to its `Fanout` entrypoint), so
 * each has the free plan's 10 ms of CPU and 50 subrequests to itself. What a check finds goes to
 * the queue as one message per person (src/work.ts).
 *
 * Every person has a fixed slot (`people.shard`, 0..59): with Google, checked every
 * GOOGLE_EVERY_MIN minutes; with only a feed, every FEED_EVERY_MIN (calendar apps fetch a feed
 * hourly at most); both longer when the Firestore read budget asks (`periodsFor`). A household's members go to the same invocation, which reads what they share once.
 *
 * Then work the queue never got (its daily operations used up, a message lost) runs from here.
 */

export const GOOGLE_EVERY_MIN = 5;
export const FEED_EVERY_MIN = 15;
/** Firestore reads one check costs: the household and settings (2), the person's two lists (2), and their share of the household's lists. */
export const READS_PER_CHECK = 5;
const PERIODS = [5, 10, 15, 20, 30, 60];

export interface Periods {
  google: number;
  feed: number;
}

/**
 * How often to check, in minutes (each divides 60): every 5 (Google) and 15 (feed only) unless that
 * would cost more Firestore reads a day than `budget` (`FIRESTORE_CHECK_READS`), the share of the
 * project's daily reads the checks may use. Firestore's free plan has 50,000 a day for everything,
 * the apps included, and once they are used up every app's reads fail until midnight Pacific; the
 * checks slow down instead.
 */
export function periodsFor(google: number, feedOnly: number, budget?: number): Periods {
  const cost = (p: Periods) => (google * 1440) / p.google + (feedOnly * 1440) / p.feed;
  for (const g of PERIODS.filter((p) => p >= GOOGLE_EVERY_MIN)) {
    const p = { google: g, feed: Math.max(FEED_EVERY_MIN, g) };
    if (!budget || cost(p) * READS_PER_CHECK <= budget) return p;
  }
  return { google: 60, feed: 60 };
}

/** The periods in force: worked out once an hour from how many people there are (src/tick.ts). */
async function currentPeriods(env: Env, minute: number): Promise<Periods> {
  const { results } = await env.DB.prepare("SELECT key, value FROM meta WHERE key IN ('period-google', 'period-feed')").all<{ key: string; value: number }>();
  const known = new Map(results.map((r) => [r.key, r.value]));
  if (minute !== 0 && known.has('period-google') && known.has('period-feed')) return { google: known.get('period-google')!, feed: known.get('period-feed')! };
  const counts = await env.DB.prepare('SELECT SUM(google = 1) AS g, SUM(google = 0 AND feed = 1) AS f FROM people').first<{ g: number | null; f: number | null }>();
  const budget = Number(env.FIRESTORE_CHECK_READS) || undefined;
  const p = periodsFor(counts?.g ?? 0, counts?.f ?? 0, budget);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO meta (key, value) VALUES ('period-google', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(p.google),
    env.DB.prepare("INSERT INTO meta (key, value) VALUES ('period-feed', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(p.feed),
  ]);
  return p;
}
/** People per check invocation (about 5 subrequests each, of 50). */
export const CHUNK = 8;
/** Invocations one cron run may start: Cloudflare allows 32 per request, the cron's own included. */
export const MAX_CALLS = 30;
const SWEEP = 10;

export interface TickDeps {
  fetch?: Fetch;
  now?: number;
  firestoreUrl?: string;
}

/** The shards (0..59) due in `minute` for a check every `every` minutes. */
export const slotsFor = (minute: number, every: number): number[] => Array.from({ length: 60 / every }, (_, i) => (minute % every) + i * every);

/** People in chunks of at most CHUNK, a household's members together where they fit. */
export function pack(rows: { pid: string; hh: string | null }[], size = CHUNK): string[][] {
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const k = r.hh ?? `pid:${r.pid}`;
    groups.set(k, [...(groups.get(k) ?? []), r.pid]);
  }
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const members of [...groups.values()].sort((a, b) => b.length - a.length)) {
    for (let i = 0; i < members.length; i += size) {
      const part = members.slice(i, i + size);
      if (current.length + part.length > size) {
        if (current.length) chunks.push(current);
        current = [];
      }
      current.push(...part);
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export async function runCron(env: Env, deps: TickDeps = {}): Promise<Record<string, number>> {
  const now = deps.now ?? Date.now();
  const minute = Math.floor(now / 60_000) % 60;
  const totals: Record<string, number> = { due: 0, calls: 0, checked: 0, marked: 0, sent: 0, echoes: 0, skipped: 0, errors: 0, deferred: 0, swept: 0, worked: 0 };
  const pause = await env.DB.prepare("SELECT value FROM meta WHERE key = 'firestore-pause'").first<{ value: number }>();
  if (pause && pause.value > now) {
    log('tick', { minute, paused: 'firestore-quota' });
    return totals;
  }
  const periods = await currentPeriods(env, minute);
  const g = slotsFor(minute, periods.google);
  const f = slotsFor(minute, periods.feed);
  const { results } = await env.DB.prepare(
    `SELECT pid, hh FROM people WHERE (google = 1 AND shard IN (${g.join(',')})) OR (google = 0 AND feed = 1 AND shard IN (${f.join(',')})) ORDER BY hh, pid`,
  ).all<{ pid: string; hh: string | null }>();
  totals.due = results.length;

  const check = (pids: string[]): Promise<CheckTotals> => (env.SELF ? env.SELF.check(pids) : checkPeople(env, pids, deps));
  const work = (pid: string): Promise<WorkOutcome> => (env.SELF ? env.SELF.work(pid) : runWork(env, pid, { ...deps, now }));

  let waiting = pack(results);
  let failed = 0;
  let paused = false;
  while (waiting.length && totals.calls < MAX_CALLS && !paused) {
    const wave = waiting.slice(0, MAX_CALLS - totals.calls);
    waiting = waiting.slice(wave.length);
    totals.calls += wave.length;
    const answers = await Promise.allSettled(wave.map(check));
    const deferred: string[] = [];
    for (const a of answers) {
      if (a.status === 'rejected') {
        failed++;
        continue;
      }
      for (const k of ['checked', 'marked', 'sent', 'echoes', 'skipped', 'errors'] as const) totals[k] += a.value[k];
      deferred.push(...a.value.deferred);
      paused ||= a.value.paused;
    }
    if (deferred.length) waiting = [...pack(deferred.map((pid) => ({ pid, hh: null }))), ...waiting];
  }
  totals.deferred = waiting.reduce((n, c) => n + c.length, 0);
  totals.failed = failed;

  // Work marked but not on its way: queue it again, or run it from here.
  const stuck = await env.DB.prepare(
    'SELECT pid FROM people WHERE work != 0 AND (queued_at IS NULL OR queued_at < ?1) AND (lease_until IS NULL OR lease_until <= ?2) AND (backoff_until IS NULL OR backoff_until <= ?2) LIMIT ?3',
  )
    .bind(now - REQUEUE_MS, now, SWEEP)
    .all<{ pid: string }>();
  for (const { pid } of stuck.results) {
    totals.swept++;
    if (await markWork(env, pid, 0, now)) continue;
    if (totals.calls >= MAX_CALLS) break;
    totals.calls++;
    const outcome = await work(pid).catch(() => null);
    if (outcome && 'done' in outcome) totals.worked++;
  }

  // The portal's "Updated ... ago" for everyone checked in this minute, when all of them were.
  if (!failed && !paused && totals.deferred === 0) {
    await env.DB.prepare('INSERT INTO ticks (minute, at) VALUES (?, ?) ON CONFLICT(minute) DO UPDATE SET at = excluded.at').bind(minute, now).run();
  }
  log('tick', { minute, every: periods.google, ...totals });
  return totals;
}

/** When the person was last checked with everyone in their slot (0 when never). */
export async function lastChecked(env: Env, shard: number, google: boolean): Promise<number> {
  const period = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(google ? 'period-google' : 'period-feed').first<{ value: number }>();
  const every = period?.value ?? (google ? GOOGLE_EVERY_MIN : FEED_EVERY_MIN);
  const minutes = slotsFor(shard, every);
  const row = await env.DB.prepare(`SELECT MAX(at) AS at FROM ticks WHERE minute IN (${minutes.join(',')})`).first<{ at: number | null }>();
  return row?.at ?? 0;
}
