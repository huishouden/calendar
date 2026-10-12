import { ReadBudget } from '@huishouden/pwa-kit/read-budget';
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { handleApi } from '../src/api';
import { checkPeople } from '../src/check';
import { FEED, markWork, runWork } from '../src/work';
import { FIRESTORE_PAUSE_MS, forgetWorkReads, quotaDay, READ_BACKOFF_MS, ROUND_READS, untilNextDay, workReadsKey } from '../src/budget';
import { loadPerson, openFeedBody, personId } from '../src/store';
import { captureLogs } from '../src/log';
import { apiRequest, drain, household, readDoc, refreshFor, resetFirestore, seed, world, TZ, type World } from './helpers/world';

// The work's Firestore reads are bounded (src/budget.ts, src/round.ts ROUND_READS): the free plan's
// 50,000 reads a day are every app's, and on 2026-10-12 one feed round read 39,000 of them in 22
// minutes, sent back from `split` to `lists` for ever by counts a write had made stale.

let w: World;

beforeAll(async () => {
  await resetFirestore();
});

beforeEach(async () => {
  await resetFirestore();
  await seed();
  w = world();
});

const MIN = 60_000;
const path = 'households/h1/agenda/baby_appointment_a1';

/** Firestore's bill for one response, worked out from the wire: what the Worker's own count must say. */
async function billed(url: string, res: Response): Promise<number> {
  if (!url.includes('firestore') && !url.includes('/v1/projects/')) return 0;
  if (!res.ok) return 0;
  const body = (await res.clone().json()) as unknown;
  if (url.endsWith(':runQuery')) return Math.max(1, (body as { document?: unknown }[]).filter((r) => r.document).length);
  if (url.endsWith(':runAggregationQuery')) return 1;
  if (url.endsWith(':batchGet')) return (body as unknown[]).length;
  return 0;
}

/** `w.fetch`, with the Firestore queries counted and the reads billed added up. */
function counting() {
  const seen = { queries: 0, reads: 0 };
  const fetch = async (url: string, init?: RequestInit) => {
    if (url.endsWith(':runQuery')) seen.queries++;
    const res = await w.fetch(url, init);
    seen.reads += await billed(url, res);
    return res;
  };
  // Every unit in the chain and from the queue goes through it.
  const self = w.env.SELF!;
  w.env.SELF = { ...self, work: (p, h) => runWork(w.env, p, { fetch, now: w.clock.now, handover: h, next: (q, k) => w.env.SELF!.work(q, k) }) };
  return { seen, fetch, run: async (pid: string) => {
    await runWork(w.env, pid, { fetch, now: w.clock.now, next: (p, h) => w.env.SELF!.work(p, h) });
    while (w.queue.length) {
      const m = w.queue.shift()! as { pid: string };
      await w.env.SELF!.work(m.pid);
    }
  } };
}

async function feedOf(email: string) {
  await handleApi(w.env, apiRequest('/api/feed', email, { household, refreshToken: refreshFor(email), lang: 'en', timeZone: TZ }), undefined, { fetch: w.fetch, now: w.clock.now });
  await drain(w);
  return personId(household, email);
}

async function feedBody(pid: string) {
  const row = (await w.env.DB.prepare('SELECT body FROM feeds WHERE pid = ?').bind(pid).first<{ body: string }>())!;
  return (await openFeedBody(w.env, (await loadPerson(w.env, pid))!.feed!.secret, row.body))!;
}

/** A household with `n` more agenda items than the fixture (invented). */
async function many(n: number) {
  const docs: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) {
    docs[`households/h1/agenda/pet_appointment_m${i}`] = { app: 'pet', ref: `appointment:m${i}`, kind: 'appointment', title: `Visit ${i}`, start: Date.parse('2031-10-03T09:00:00Z') + i * 3_600_000, end: Date.parse('2031-10-03T10:00:00Z') + i * 3_600_000, allDay: false, url: 'https://huishouden-piekstra.web.app/pet/', private: false, updatedAt: Date.parse('2031-09-30T12:00:00Z') + i, by: 'bob@example.com' };
  }
  await seed(docs);
}

describe('a write between the check and the round', () => {
  test('the round finishes, reading what changed once, and the feed has the latest', async () => {
    const pid = await feedOf('alice@example.com');
    await seed({ [path]: { ...(await readDoc(path))!, title: 'Checkup at 18 months', updatedAt: w.clock.now + MIN } });
    w.clock.now += 2 * MIN;
    expect((await checkPeople(w.env, [pid], { now: w.clock.now, fetch: w.fetch })).marked).toBe(1);
    w.queue.length = 0;
    // An admin changes it again after the check counted the lists: the counts the round starts from are stale.
    await seed({ [path]: { ...(await readDoc(path))!, title: 'Checkup moved', updatedAt: w.clock.now } });
    const c = counting();
    const logs = captureLogs();
    await c.run(pid);
    logs.restore();
    // Before the fix this never ended: lists, split, lists, split... every list read whole each time.
    expect(c.seen.queries).toBeLessThanOrEqual(4);
    const units = logs.lines.map((l) => JSON.parse(l) as { event: string; step?: string }).filter((l) => l.event === 'work');
    expect(units.filter((u) => u.step?.startsWith('lists')).length).toBe(1);
    expect(await feedBody(pid)).toContain('SUMMARY:Checkup moved');
    expect((await w.env.DB.prepare('SELECT work FROM people WHERE pid = ?').bind(pid).first<{ work: number }>())!.work).toBe(0);
  });
});

describe('reads are counted', () => {
  test("each unit's reads are what Firestore bills, logged, added to the day's count; the round's total logged and on the person's row", async () => {
    await many(40);
    const pid = await feedOf('alice@example.com');
    await w.env.DB.prepare('DELETE FROM lists').run();
    await w.env.DB.prepare('DELETE FROM meta').run();
    await markWork(w.env, pid, FEED, w.clock.now, { queue: false });
    const c = counting();
    const logs = captureLogs();
    await c.run(pid);
    logs.restore();
    const lines = logs.lines.map((l) => JSON.parse(l) as { event: string; reads?: number; kind?: string });
    const units = lines.filter((l) => l.event === 'work');
    expect(c.seen.reads).toBeGreaterThan(40);
    expect(units.reduce((n, u) => n + (u.reads ?? 0), 0)).toBe(c.seen.reads);
    const round = lines.find((l) => l.event === 'round')!;
    // Counts only: no one named in the logs.
    expect(round).toEqual({ event: 'round', kind: 'feed', reads: c.seen.reads });
    expect(await w.env.DB.prepare('SELECT round_reads, round_reads_at FROM people WHERE pid = ?').bind(pid).first<Record<string, number>>()).toEqual({ round_reads: c.seen.reads, round_reads_at: w.clock.now });
    const day = await w.env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(workReadsKey(w.clock.now)).first<{ value: number }>();
    expect(day!.value).toBe(c.seen.reads);
  });
});

describe('a round that keeps reading', () => {
  test('stops past ROUND_READS: the round goes, the person waits READ_BACKOFF_MS, their row says how much it read', async () => {
    await many(150);
    const pid = await feedOf('alice@example.com');
    // The kept lists never come back (as if another round replaced them each time): `split` sends
    // the round back to `lists` again and again.
    const db = w.env.DB;
    w.env.DB = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'prepare')
          return (sql: string) => {
            const s = target.prepare(sql);
            if (!sql.startsWith('SELECT key, body, at, used_at FROM lists')) return s;
            return { bind: () => ({ all: async () => ({ results: [] }) }) } as unknown as D1PreparedStatement;
          };
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    await markWork(w.env, pid, FEED, w.clock.now, { queue: false });
    const c = counting();
    const logs = captureLogs();
    await c.run(pid);
    logs.restore();
    w.env.DB = db;
    const lines = logs.lines.map((l) => JSON.parse(l) as { event: string; reason?: string; reads?: number });
    const stop = lines.find((l) => l.reason === 'read-budget')!;
    expect(stop.reads).toBeGreaterThan(ROUND_READS);
    expect(Object.keys(stop).sort()).toEqual(['event', 'kind', 'ok', 'reads', 'reason']);
    expect((await w.env.DB.prepare('SELECT round_reads FROM people WHERE pid = ?').bind(pid).first<{ round_reads: number }>())!.round_reads).toBe(stop.reads!);
    // At most one unit's reads past the budget.
    expect(c.seen.reads).toBeLessThan(ROUND_READS + 400);
    const row = (await w.env.DB.prepare('SELECT work, round, backoff_until, lease_until FROM people WHERE pid = ?').bind(pid).first<{ work: number; round: string | null; backoff_until: number; lease_until: number | null }>())!;
    expect(row.round).toBeNull();
    expect(row.lease_until).toBeNull();
    expect(row.backoff_until).toBe(w.clock.now + READ_BACKOFF_MS);
    // The work is still marked: it runs again once the person's wait is over.
    expect(row.work & FEED).toBe(FEED);
    expect(await runWork(w.env, pid, { fetch: w.fetch, now: w.clock.now + MIN })).toMatchObject({ reason: 'backoff' });
    w.clock.now += READ_BACKOFF_MS;
    await drain(w);
    expect(await runWork(w.env, pid, { fetch: w.fetch, now: w.clock.now, next: (p, h) => w.env.SELF!.work(p, h) })).toMatchObject({ done: true });
    await drain(w);
    expect((await w.env.DB.prepare('SELECT work FROM people WHERE pid = ?').bind(pid).first<{ work: number }>())!.work).toBe(0);
  });
});

describe('what is counted', () => {
  test("every Firestore call a Person makes goes through its budget: the kit's count is what the wire bills", async () => {
    // A query of more documents than one page holds is still one request, billed each document.
    await many(320);
    const c = counting();
    const p = new (await import('../src/person')).Person(w.env, { household, email: 'alice@example.com', refreshToken: refreshFor('alice@example.com') }, c.fetch, undefined, new ReadBudget());
    const docs = await p.db.query(`households/${household}`, 'agenda');
    expect(docs.length).toBeGreaterThan(320);
    await p.getAll([`households/${household}`, `households/${household}/calendarSettings/alice@example.com`]);
    await p.db.aggregate(`households/${household}`, 'agenda', {}, ['updatedAt']);
    expect(c.seen.queries).toBe(1);
    expect(p.budget.reads).toBe(docs.length + 2 + 1);
    expect(c.seen.reads).toBe(p.budget.reads);
  });
});

describe("the day's budget and Firestore's quota", () => {
  test('past FIRESTORE_WORK_READS no chain starts: the person waits for midnight Pacific, nothing is read', async () => {
    const pid = await feedOf('alice@example.com');
    w.env.FIRESTORE_WORK_READS = '100';
    await w.env.DB.prepare('INSERT INTO meta (key, value) VALUES (?, 100) ON CONFLICT(key) DO UPDATE SET value = 100').bind(workReadsKey(w.clock.now)).run();
    await markWork(w.env, pid, FEED, w.clock.now, { queue: false });
    const c = counting();
    const outcome = await runWork(w.env, pid, { fetch: c.fetch, now: w.clock.now });
    expect(outcome).toEqual({ retryAfter: Math.ceil(untilNextDay(w.clock.now) / 1000), reason: 'budget' });
    expect(c.seen.reads).toBe(0);
    const row = (await w.env.DB.prepare('SELECT backoff_until, work FROM people WHERE pid = ?').bind(pid).first<{ backoff_until: number; work: number }>())!;
    expect(row.backoff_until).toBe(w.clock.now + untilNextDay(w.clock.now));
    expect(row.work & FEED).toBe(FEED);
    // Under the budget it runs.
    w.env.FIRESTORE_WORK_READS = '1000';
    await w.env.DB.prepare('UPDATE people SET backoff_until = NULL WHERE pid = ?').bind(pid).run();
    expect(await runWork(w.env, pid, { fetch: c.fetch, now: w.clock.now, next: (p, h) => w.env.SELF!.work(p, h) })).toMatchObject({ done: true });
  });

  test('Firestore over its quota mid-round: work and checks pause FIRESTORE_PAUSE_MS, the round kept for later', async () => {
    const pid = await feedOf('alice@example.com');
    await w.env.DB.prepare('DELETE FROM lists').run();
    await markWork(w.env, pid, FEED, w.clock.now, { queue: false });
    const over = async (url: string, init?: RequestInit) =>
      url.endsWith(':runQuery') ? Response.json([{ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded.' } }], { status: 429 }) : w.fetch(url, init);
    // view, then lists: the lists' queries are refused.
    const first = await runWork(w.env, pid, { fetch: over, now: w.clock.now, next: (p, h) => runWork(w.env, p, { fetch: over, now: w.clock.now, handover: h }) });
    expect(first).toMatchObject({ done: true });
    const pause = (await w.env.DB.prepare("SELECT value FROM meta WHERE key = 'firestore-pause'").first<{ value: number }>())!;
    expect(pause.value).toBe(w.clock.now + FIRESTORE_PAUSE_MS);
    const row = (await w.env.DB.prepare('SELECT round, lease_until FROM people WHERE pid = ?').bind(pid).first<{ round: string | null; lease_until: number | null }>())!;
    expect(row.round).not.toBeNull();
    expect(row.lease_until).toBeNull();
    // Meanwhile nothing starts.
    expect(await runWork(w.env, pid, { fetch: w.fetch, now: w.clock.now + MIN })).toEqual({ retryAfter: Math.ceil((FIRESTORE_PAUSE_MS - MIN) / 1000), reason: 'paused' });
    // After it, the round goes on and the feed is built.
    w.clock.now += FIRESTORE_PAUSE_MS;
    expect(await runWork(w.env, pid, { fetch: w.fetch, now: w.clock.now, next: (p, h) => w.env.SELF!.work(p, h) })).toMatchObject({ done: true });
    await drain(w);
    expect(await feedBody(pid)).toContain('SUMMARY:Garbage pickup');
  });

  test('the quota day is Pacific: it turns at 07:00 UTC in summer, 08:00 in winter; old counts are forgotten', async () => {
    expect(quotaDay(Date.parse('2031-10-01T06:59:00Z'))).toBe('2031-09-30');
    expect(quotaDay(Date.parse('2031-10-01T07:00:00Z'))).toBe('2031-10-01');
    expect(untilNextDay(Date.parse('2031-10-01T06:30:00Z'))).toBe(30 * MIN);
    expect(untilNextDay(Date.parse('2031-12-01T07:30:00Z'))).toBe(30 * MIN);
    const now = Date.parse('2031-10-03T12:00:00Z');
    for (const d of [0, 1, 2, 3]) await w.env.DB.prepare('INSERT INTO meta (key, value) VALUES (?, 5)').bind(workReadsKey(now - d * 24 * 3_600_000)).run();
    await forgetWorkReads(w.env, now);
    const { results } = await w.env.DB.prepare("SELECT key FROM meta WHERE key LIKE 'work-reads:%' ORDER BY key").all<{ key: string }>();
    expect(results.map((r) => r.key)).toEqual([workReadsKey(now - 24 * 3_600_000), workReadsKey(now)]);
  });
});
