import type { Env } from './env';

/**
 * The Firestore reads the work (feed builds and sync rounds, src/work.ts) may use, on top of the
 * checks' share (`FIRESTORE_CHECK_READS`, src/tick.ts). The free plan's 50,000 reads a day are the
 * whole project's, every app's included, and once they are gone every app's reads fail until
 * midnight Pacific. So:
 *
 * - a round stops past ROUND_READS (checked after each of its steps, src/round.ts) and the person
 *   waits READ_BACKOFF_MS (src/work.ts);
 * - the work counts what each unit was billed for in D1 (`meta`, a row a day) and stops for the day
 *   at `FIRESTORE_WORK_READS`;
 * - it stops for a while when Firestore says the quota is used up (`firestore-pause`, as the checks do).
 *
 * The person's last round's reads are on their row (`people.round_reads`); the logs carry counts only.
 */

/**
 * Firestore reads one round may be billed for, 5% of the free plan's 50,000 a day. A busy
 * household's first build reads its four lists whole (a few hundred documents).
 */
export const ROUND_READS = 2_500;

/** A person whose round went past ROUND_READS waits this long before the next. */
export const READ_BACKOFF_MS = 60 * 60_000;

/** Whether a round billed `reads` so far is past ROUND_READS. */
export const roundOverBudget = (reads: number): boolean => reads > ROUND_READS;

/** The round went past ROUND_READS: it is dropped. */
export class ReadBudgetSpent extends Error {
  constructor(readonly reads: number) {
    super(`round read budget spent: ${reads} reads`);
    this.name = 'ReadBudgetSpent';
  }
}

/** Firestore over its quota: no checks or work for this long (the cron and the work read `firestore-pause`). */
export const FIRESTORE_PAUSE_MS = 15 * 60_000;

const pacific = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The quota's day, as Firestore's free plan counts it (it resets at midnight Pacific): "2031-10-01". */
export const quotaDay = (now: number): string => pacific.format(now);

/** The `meta` key of the work's reads on the quota day of `now`. */
export const workReadsKey = (now: number): string => `work-reads:${quotaDay(now)}`;

/** `FIRESTORE_WORK_READS` as a number; undefined (no limit) when unset, 0 or not a whole number. */
export function workReadsBudget(env: Pick<Env, 'FIRESTORE_WORK_READS'>): number | undefined {
  const n = Number(env.FIRESTORE_WORK_READS);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** The unit's reads added to the day's (a statement for the unit's batch). */
export const addWorkReads = (env: Env, now: number, reads: number): D1PreparedStatement =>
  env.DB.prepare('INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = value + excluded.value').bind(workReadsKey(now), reads);

/** Firestore said its quota is used up: checks and work wait FIRESTORE_PAUSE_MS. */
export const pauseFirestore = (env: Env, now: number): Promise<unknown> =>
  env.DB.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind('firestore-pause', now + FIRESTORE_PAUSE_MS).run();

/** Milliseconds from `now` to the next midnight Pacific (when the day's budget and Firestore's quota start again). */
export function untilNextDay(now: number): number {
  const day = quotaDay(now);
  // Midnight Pacific is 07:00 or 08:00 UTC: the first hour after `now` that is a new day there.
  let t = Math.floor(now / 3_600_000) * 3_600_000;
  while (quotaDay(t) === day) t += 3_600_000;
  return t - now;
}

/**
 * Whether a chain of work may start now (one D1 read): not while Firestore is paused, nor once the
 * day's reads are at the budget. `wait` is how long to wait, in milliseconds.
 */
export async function workGate(env: Env, now: number): Promise<{ wait: number; reason: 'paused' | 'budget'; reads?: number } | null> {
  const key = workReadsKey(now);
  const { results } = await env.DB.prepare("SELECT key, value FROM meta WHERE key IN ('firestore-pause', ?)").bind(key).all<{ key: string; value: number }>();
  const pause = results.find((r) => r.key === 'firestore-pause')?.value;
  if (pause && pause > now) return { wait: pause - now, reason: 'paused' };
  const budget = workReadsBudget(env);
  const reads = results.find((r) => r.key === key)?.value ?? 0;
  if (budget && reads >= budget) return { wait: untilNextDay(now), reason: 'budget', reads };
  return null;
}

/** The days' counts before yesterday's (src/tick.ts, hourly). */
export async function forgetWorkReads(env: Env, now: number): Promise<void> {
  await env.DB.prepare("DELETE FROM meta WHERE key LIKE 'work-reads:%' AND key < ?").bind(workReadsKey(now - 24 * 3_600_000)).run();
}
