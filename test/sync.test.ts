import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { handleApi } from '../src/api';
import { syncPerson, MAX_WRITES } from '../src/sync';
import { runCron, runPart, nextAlarm, pack, periodsFor, CHUNK, CAPACITY, slotsFor, GOOGLE_EVERY_MIN, FEED_EVERY_MIN, MAX_CALLS, READS_PER_CHECK, googleChecksPerDay } from '../src/tick';
import { runWork, SYNC, FEED, markWork, MAX_CHAIN } from '../src/work';
import { checkPeople } from '../src/check';
import { personId, loadPerson } from '../src/store';
import { eventId, instanceId } from '../src/google/events';
import { captureLogs } from '../src/log';
import { apiRequest, drain, FIRESTORE, household, listDocs, readDoc, refreshFor, resetFirestore, seed, world, writeDoc, TZ, type World } from './helpers/world';

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
/** An invented home in another zone than the person's device (TZ, Europe/Amsterdam). */
const HOME = { address: '12 Example Lane, Springfield, Illinois 62701', lat: 39.7817, lng: -89.6501, timeZone: 'America/Chicago', setBy: 'alice@example.com', updatedAt: 1 };
const call = (path: string, email: string, body?: Record<string, unknown>) => handleApi(w.env, apiRequest(path, email, body), undefined, { fetch: w.fetch, now: w.clock.now });

async function connect(email = 'alice@example.com'): Promise<{ pid: string; calendarId: string }> {
  const res = await call('/api/google/connect', email, { household, code: 'good-code', refreshToken: refreshFor(email), lang: 'en', timeZone: TZ });
  expect(res.status).toBe(200);
  // The first sync is queued work, never part of the request.
  await drain(w);
  const pid = await personId(household, email);
  const calendarId = (await loadPerson(w.env, pid))!.google!.calendarId;
  return { pid, calendarId };
}

/** Five minutes later, the cron's sync for one person. */
async function later(pid: string, minutes = 5) {
  w.clock.now += minutes * MIN;
  return syncPerson(w.env, pid, { fetch: w.fetch, now: w.clock.now });
}

const ids = async (pid: string) => ({ bins: await eventId(pid, 'home|event:bins'), checkup: await eventId(pid, 'baby|appointment:a1') });

describe('connecting', () => {
  test('makes a green "Huishouden" calendar in the person’s zone and fills it', async () => {
    const { pid, calendarId } = await connect();
    const cal = w.google.cal(calendarId);
    expect(cal.summary).toBe('Huishouden');
    expect(cal.timeZone).toBe(TZ);
    expect(cal.colour).toBe('#2d6a4f');
    const { bins, checkup } = await ids(pid);
    const master = cal.events.get(bins)!;
    expect(master.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=TH;WKST=SU', 'EXDATE;TZID=Europe/Amsterdam:20311016T070000']);
    expect(master.start).toEqual({ dateTime: '2031-09-04T07:00:00', timeZone: TZ });
    expect(master.extendedProperties?.private?.huishouden).toBe(`${household}:home|event:bins`);
    expect(cal.events.get(checkup)!.summary).toBe('Checkup');
    expect(w.google.live(calendarId).map((e) => e.summary).sort()).toEqual(['Checkup', 'Garbage pickup', 'Medicine for Nan', 'Power bill', 'To do: Buy paint']);
  });

  test('Continue in this tab: the code is exchanged with the page Google sent it to, only a listed one', async () => {
    const odd = await call('/api/google/connect', 'alice@example.com', { household, code: 'good-code', redirectUri: 'https://evil.example/my-calendar', refreshToken: refreshFor('alice@example.com'), lang: 'en', timeZone: TZ });
    expect(odd.status).toBe(400);
    expect(((await odd.json()) as { error: string }).error).toBe('redirect-uri');
    expect(w.google.redirects).toEqual([]);
    const res = await call('/api/google/connect', 'alice@example.com', { household, code: 'good-code', redirectUri: 'https://site.example/my-calendar', refreshToken: refreshFor('alice@example.com'), lang: 'en', timeZone: TZ });
    expect(res.status).toBe(200);
    await call('/api/google/connect', 'alice@example.com', { household, code: 'good-code', refreshToken: refreshFor('alice@example.com'), lang: 'en', timeZone: TZ });
    expect(w.google.redirects).toEqual(['https://site.example/my-calendar', 'postmessage']);
  });

  test('a failed connect says why in the log (Google’s error name), with nothing personal', async () => {
    const logs = captureLogs();
    const res = await call('/api/google/connect', 'alice@example.com', { household, code: 'bad-code', refreshToken: refreshFor('alice@example.com'), lang: 'en', timeZone: TZ });
    logs.restore();
    expect(res.status).toBe(400);
    const line = JSON.parse(logs.lines.find((l) => l.includes('"api"'))!) as Record<string, unknown>;
    expect(line.code).toBe('google-revoked');
    expect(String(line.detail)).toContain('invalid_grant');
    expect(logs.lines.join('\n')).not.toMatch(/example\.com|bad-code|h1/);
  });

  test('with the runtime’s own fetch (none passed in), which refuses to be called as a method, as Workers’ does', async () => {
    const real = globalThis.fetch;
    const faked = new Set(['oauth2.googleapis.com', 'www.googleapis.com', 'securetoken.googleapis.com', 'identitytoolkit.googleapis.com']);
    globalThis.fetch = function (this: unknown, url: string | URL | Request, init?: RequestInit) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation: function called with incorrect `this` reference');
      const u = String(url);
      return faked.has(new URL(u).hostname) ? w.fetch(u, init) : real(u, init);
    } as typeof fetch;
    try {
      const res = await handleApi(w.env, apiRequest('/api/google/connect', 'alice@example.com', { household, code: 'good-code', refreshToken: refreshFor('alice@example.com'), lang: 'en', timeZone: TZ }), undefined, { now: w.clock.now });
      expect(res.status).toBe(200);
      const calendarId = (await loadPerson(w.env, await personId(household, 'alice@example.com')))!.google!.calendarId;
      expect(w.google.cal(calendarId).summary).toBe('Huishouden');
    } finally {
      globalThis.fetch = real;
    }
  });

  test('Google’s code without calendar access is refused, and nothing is kept', async () => {
    const res = await call('/api/google/connect', 'alice@example.com', { household, code: 'no-calendar', refreshToken: refreshFor('alice@example.com'), lang: 'en', timeZone: TZ });
    expect(res.status).toBe(400);
    expect((await loadPerson(w.env, await personId(household, 'alice@example.com')))?.google).toBeUndefined();
  });

  test('a helper’s calendar has no bills and no Health', async () => {
    const { calendarId } = await connect('helen@example.com');
    const titles = w.google.live(calendarId).map((e) => e.summary);
    expect(titles).not.toContain('Power bill');
    expect(titles).not.toContain('Medicine for Nan');
  });
});

describe('keeping it in step', () => {
  test('nothing changed: our own writes come back as echoes and nothing is written', async () => {
    const { pid } = await connect();
    const before = w.google.calls.length;
    const counts = await later(pid);
    expect(counts.echoes).toBeGreaterThan(0);
    expect(counts.changes).toBe(counts.echoes);
    expect(counts.inserted + counts.updated + counts.deleted).toBe(0);
    expect(w.google.calls.slice(before).filter((c) => !c.startsWith('GET'))).toEqual([]);
    // And the run after that is just the change list.
    const quiet = await later(pid);
    expect(quiet.changes).toBe(0);
    expect(quiet.full).toBe(false);
  });

  test("the household's home: Home events get its address as location, and the calendar moves to the home's zone", async () => {
    const { pid, calendarId } = await connect();
    const { bins, checkup } = await ids(pid);
    expect(w.google.cal(calendarId).events.get(bins)!.location).toBeUndefined();
    await writeDoc(`households/${household}`, { ...(await readDoc(`households/${household}`))!, home: HOME });
    const counts = await later(pid);
    expect(counts.updated).toBeGreaterThan(0);
    const cal = w.google.cal(calendarId);
    const master = cal.events.get(bins)!;
    expect(master.location).toBe(HOME.address);
    expect(master.start).toEqual({ dateTime: '2031-09-04T07:00:00', timeZone: 'America/Chicago' });
    expect(master.recurrence).toContain('EXDATE;TZID=America/Chicago:20311016T070000');
    expect(cal.events.get(checkup)!.location).toBeUndefined();
    // Settled: the next run writes nothing.
    const quiet = await later(pid);
    expect(quiet.inserted + quiet.updated + quiet.deleted).toBe(0);
    // The home removed: the address goes from the event again.
    const { home: _h, ...without } = (await readDoc(`households/${household}`))!;
    await writeDoc(`households/${household}`, without);
    await later(pid);
    expect(w.google.cal(calendarId).events.get(bins)!.location).toBeUndefined();
    expect(w.google.cal(calendarId).events.get(bins)!.start).toEqual({ dateTime: '2031-09-04T07:00:00', timeZone: TZ });
  });

  test("connecting in a household with a home makes the calendar in the home's zone", async () => {
    await writeDoc(`households/${household}`, { ...(await readDoc(`households/${household}`))!, home: HOME });
    const { calendarId } = await connect('bob@example.com');
    expect(w.google.cal(calendarId).timeZone).toBe('America/Chicago');
  });

  test('an item changed in the app: only its event is rewritten', async () => {
    const { pid, calendarId } = await connect();
    const path = `households/${household}/agenda/baby_appointment_a1`;
    await writeDoc(path, { ...(await readDoc(path))!, title: 'Checkup at 18 months', updatedAt: w.clock.now + MIN });
    const counts = await later(pid);
    expect([counts.inserted, counts.updated, counts.deleted]).toEqual([0, 1, 0]);
    expect(w.google.cal(calendarId).events.get((await ids(pid)).checkup)!.summary).toBe('Checkup at 18 months');
  });

  test('an item gone from the agenda leaves the calendar; one added arrives', async () => {
    const { pid, calendarId } = await connect();
    await fetch(`${FIRESTORE}/projects/demo-huishouden-calendar/databases/(default)/documents/households/${household}/todos/${encodeURIComponent('tasks:item:paint')}`, { method: 'DELETE', headers: { Authorization: 'Bearer owner' } });
    await writeDoc(`households/${household}/agenda/home_job_filter`, { app: 'home', ref: 'job:filter', kind: 'due', title: 'Change the furnace filter', start: Date.parse('2031-10-15T00:00:00+02:00'), allDay: true, url: 'https://huishouden-piekstra.web.app/home/', status: 'upcoming', private: false, updatedAt: w.clock.now, by: 'bob@example.com' });
    const counts = await later(pid);
    expect([counts.inserted, counts.deleted]).toEqual([1, 1]);
    const live = w.google.live(calendarId).map((e) => e.summary);
    expect(live).toContain('Change the furnace filter');
    expect(live).not.toContain('To do: Buy paint');
    const job = w.google.live(calendarId).find((e) => e.summary === 'Change the furnace filter')!;
    expect(job.start).toEqual({ date: '2031-10-15' });
  });

  test('the cron checks each person once in 5 minutes, fanned out, and queues only who changed; counts only in its log', async () => {
    const a = await connect('alice@example.com');
    const b = await connect('bob@example.com');
    const checked: string[][] = [];
    const self = w.env.SELF!;
    w.env.SELF = { ...self, check: (pids) => (checked.push(pids), self.check(pids)) };
    // Our own writes come back as echoes once; let the checks take those first.
    for (let m = 0; m < GOOGLE_EVERY_MIN; m++) await runCron(w.env, { fetch: w.fetch, now: w.clock.now + m * MIN });
    w.clock.now += GOOGLE_EVERY_MIN * MIN;
    await drain(w);
    checked.length = 0;
    const path = `households/${household}/agenda/baby_appointment_a1`;
    await writeDoc(path, { ...(await readDoc(path))!, title: 'Checkup at 18 months', updatedAt: w.clock.now });
    const logs = captureLogs();
    const totals: Record<string, number>[] = [];
    for (let m = 0; m < GOOGLE_EVERY_MIN; m++) totals.push(await runCron(w.env, { fetch: w.fetch, now: w.clock.now + m * MIN }));
    logs.restore();
    // Each person exactly once in the five minutes, in its own invocation's chunk.
    expect(checked.flat().sort()).toEqual([a.pid, b.pid].sort());
    expect(totals.reduce((n, t) => n + t.marked, 0)).toBe(2);
    expect(w.queue.map((m) => ('pid' in m ? m.pid : m.inbox)).sort()).toEqual([a.pid, b.pid].sort());
    await drain(w);
    for (const p of [a, b]) expect(w.google.cal(p.calendarId).events.get((await ids(p.pid)).checkup)!.summary).toBe('Checkup at 18 months');
    expect(logs.lines.join('\n')).not.toMatch(/example\.com|Checkup|Garbage|h1/);
  });
});

describe('fan-out and the queue', () => {
  test('the signal from the loaded agenda equals the aggregations’ (so a unit needn’t ask twice), for every role', async () => {
    const { Person } = await import('../src/person');
    for (const email of ['alice@example.com', 'bob@example.com', 'helen@example.com', 'kim@example.com']) {
      const p = new Person(w.env, { household, email, refreshToken: refreshFor(email) }, w.fetch);
      const view = await p.view();
      expect(p.signalOf(view, await p.load(view), 'x')).toBe(await p.signal(view, 'x'));
    }
  });

  test('slots: Google people every 5 minutes, feed-only people every 15; a household together', () => {
    for (let m = 0; m < 60; m++) {
      expect(slotsFor(m, GOOGLE_EVERY_MIN).length).toBe(12);
      expect(slotsFor(m, FEED_EVERY_MIN).length).toBe(4);
    }
    const all = new Set(Array.from({ length: GOOGLE_EVERY_MIN }, (_, m) => slotsFor(m, GOOGLE_EVERY_MIN)).flat());
    expect(all.size).toBe(60);
    const rows = [...'abcdefghij'].map((c, i) => ({ pid: c, hh: i < 3 ? 'h-x' : i < 6 ? 'h-y' : null }));
    const chunks = pack(rows, 4);
    expect(chunks.every((c) => c.length <= 4)).toBe(true);
    expect(chunks.flat().sort()).toEqual([...'abcdefghij']);
    expect(chunks.some((c) => ['a', 'b', 'c'].every((p) => c.includes(p)))).toBe(true);
    expect(chunks.some((c) => ['d', 'e', 'f'].every((p) => c.includes(p)))).toBe(true);
  });

  test('more chunks than the cron’s 30 invocations: Tickers take the other parts; together they check everyone once', async () => {
    const shard = 7;
    for (let i = 0; i < 70; i++) await w.env.DB.prepare('INSERT INTO people (pid, created_at, shard, google, hh) VALUES (?, 0, ?, 1, ?)').bind(`fake${String(i).padStart(2, '0')}`, shard, `hh${i}`).run();
    const armed: number[] = [];
    w.env.TICKER = { idFromName: (n: string) => n, get: () => ({ arm: async (k: number) => void armed.push(k) }) } as never;
    const checked: string[] = [];
    const self = w.env.SELF!;
    w.env.SELF = { ...self, check: async (pids) => (checked.push(...pids), self.check(pids)) };
    const at = Math.floor(w.clock.now / 3_600_000) * 3_600_000 + 3_600_000 + shard * MIN;
    const cron = await runCron(w.env, { fetch: w.fetch, now: at });
    expect(cron.parts).toBe(2);
    expect(armed).toEqual([1]);
    expect(cron.calls).toBeLessThanOrEqual(MAX_CALLS);
    const ticker = await runPart(w.env, { fetch: w.fetch, now: at + 5_000, part: 1 });
    expect(ticker.calls).toBeLessThanOrEqual(MAX_CALLS);
    expect(checked.sort()).toEqual(Array.from({ length: 70 }, (_, i) => `fake${String(i).padStart(2, '0')}`));
    // A minute that needs one part: Ticker 1 is told to stop.
    await w.env.DB.prepare("DELETE FROM people WHERE pid LIKE 'fake%'").run();
    await runCron(w.env, { fetch: w.fetch, now: at + 60_000 });
    expect((await runPart(w.env, { fetch: w.fetch, now: at + 65_000, part: 1 })).stop).toBe(1);
    expect(nextAlarm(at + 5_000)).toBe(at + 65_000);
  });

  test('more people than the minute’s capacity: checks space out rather than overflow', () => {
    const p = periodsFor(5000, 0);
    expect((1.25 * 5000) / p.google).toBeLessThanOrEqual(CAPACITY);
    expect(p.google).toBeGreaterThan(GOOGLE_EVERY_MIN);
    expect(periodsFor(1000, 0)).toEqual({ google: 5, feed: 15 });
  });

  test('a Firestore read budget: the checks slow down rather than go over it', () => {
    expect(periodsFor(1000, 1000)).toEqual({ google: 5, feed: 15 });
    // 20 people with Google and 20 with a feed: Google every 5 minutes (a household side every 15
    // while quiet, a quarter of the day active) would be 28,800 reads a day.
    expect(periodsFor(20, 20, 20_000)).toEqual({ google: 20, feed: 20 });
    const p = periodsFor(20, 20, 20_000);
    expect((20 * googleChecksPerDay(p.google) + 20 * 1440 / p.feed) * READS_PER_CHECK).toBeLessThanOrEqual(20_000);
    // Google people alone: 23 keep 5-minute checks within 20,000 (13 when every check read the household).
    expect(periodsFor(23, 0, 20_000)).toEqual({ google: 5, feed: 15 });
    expect(periodsFor(5, 0, 20_000)).toEqual({ google: 5, feed: 15 });
    expect(periodsFor(1000, 0, 20_000)).toEqual({ google: 60, feed: 60 });
  });

  test('a household’s members share its reads: fewer Firestore requests than one check each', async () => {
    const people = await Promise.all(['alice@example.com', 'bob@example.com', 'cora@example.com'].map(async (e) => (await connect(e)).pid));
    let firestore = 0;
    const counting = (url: string, init?: RequestInit) => {
      if (url.includes('/v1/projects/')) firestore++;
      return w.fetch(url, init);
    };
    await checkPeople(w.env, [people[0]], { fetch: counting, now: w.clock.now });
    const one = firestore;
    firestore = 0;
    await checkPeople(w.env, people, { fetch: counting, now: w.clock.now });
    expect(firestore).toBeLessThan(3 * one);
  });

  test('per-person order: a unit holding the person makes another wait; the checks leave them alone meanwhile', async () => {
    const { pid } = await connect();
    await w.env.DB.prepare('UPDATE people SET work = ?, lease_until = ? WHERE pid = ?').bind(SYNC, w.clock.now + 60_000, pid).run();
    const busy = await runWork(w.env, pid, { fetch: w.fetch, now: w.clock.now });
    expect(busy).toEqual({ retryAfter: 30, reason: 'busy' });
    const totals = await checkPeople(w.env, [pid], { fetch: w.fetch, now: w.clock.now });
    expect(totals.skipped).toBe(1);
    // Once the lease ends (or runs out), the waiting unit runs, and the round's next units after it.
    w.clock.now += 61_000;
    expect('done' in (await runWork(w.env, pid, { fetch: w.fetch, now: w.clock.now, next: (p, h) => w.env.SELF!.work(p, h) }))).toBe(true);
    await drain(w);
    expect((await w.env.DB.prepare('SELECT work, lease_until FROM people WHERE pid = ?').bind(pid).first<Record<string, unknown>>())).toEqual({ work: 0, lease_until: null });
  });

  test('feed and sync for one person: one round does both (one export), each unit its own invocation', async () => {
    await call('/api/feed', 'alice@example.com', { household, refreshToken: refreshFor('alice@example.com'), lang: 'en', timeZone: TZ });
    const { pid } = await connect();
    const units: number[] = [];
    const self = w.env.SELF!;
    w.env.SELF = { ...self, work: async (p, h) => (units.push(h?.depth ?? 0), self.work(p, h)) };
    const logs = captureLogs();
    const path = `households/${household}/agenda/baby_appointment_a1`;
    await writeDoc(path, { ...(await readDoc(path))!, title: 'Checkup at 18 months', updatedAt: w.clock.now + MIN });
    const totals = await checkPeople(w.env, [pid], { fetch: w.fetch, now: w.clock.now });
    expect(totals.marked).toBe(1);
    expect((await w.env.DB.prepare('SELECT work FROM people WHERE pid = ?').bind(pid).first<{ work: number }>())!.work).toBe(FEED | SYNC);
    expect(w.queue.length).toBe(1);
    const first = await runWork(w.env, pid, { fetch: w.fetch, now: w.clock.now, next: (p, h) => w.env.SELF!.work(p, h) });
    await drain(w);
    logs.restore();
    expect(first).toEqual({ done: true, kind: 'sync', more: true });
    // Each next unit through `SELF` (its own invocation), MAX_CHAIN at most before the queue takes over.
    expect(units.length).toBeGreaterThan(1);
    expect(Math.max(...units)).toBeLessThan(MAX_CHAIN);
    const lines = logs.lines.map((l) => JSON.parse(l) as { event: string; kind?: string; built?: boolean });
    // The sync round built the feed from the same export: no feed round of its own.
    expect(new Set(lines.filter((l) => l.event === 'work').map((l) => l.kind))).toEqual(new Set(['sync']));
    expect(lines.filter((l) => l.event === 'feed' && l.built).length).toBe(1);
    expect((await w.env.DB.prepare('SELECT work FROM people WHERE pid = ?').bind(pid).first<{ work: number }>())!.work).toBe(0);
    expect(w.google.live((await loadPerson(w.env, pid))!.google!.calendarId).some((e) => e.summary === 'Checkup at 18 months')).toBe(true);
  });

  test('more than one unit of writes: the rest goes in the next unit straight away', async () => {
    const { pid, calendarId } = await connect();
    // Many new items at once: more writes than one unit makes.
    for (let i = 0; i < MAX_WRITES + 5; i++) {
      await writeDoc(`households/${household}/agenda/home_job_x${i}`, { app: 'home', ref: `job:x${i}`, kind: 'due', title: `Job ${i}`, start: Date.parse('2031-10-15T00:00:00+02:00'), allDay: true, url: 'https://huishouden-piekstra.web.app/home/', status: 'upcoming', private: false, updatedAt: w.clock.now, by: 'bob@example.com' });
    }
    w.clock.now += MIN;
    await markWork(w.env, pid, SYNC, w.clock.now);
    let units = 0;
    const self = w.env.SELF!;
    w.env.SELF = { ...self, work: async (p, h) => (units++, self.work(p, h)) };
    await drain(w);
    expect(units).toBeGreaterThanOrEqual(1);
    expect(w.google.live(calendarId).filter((e) => e.summary?.startsWith('Job ')).length).toBe(MAX_WRITES + 5);
  });

  test('Google says too many requests: the person backs off, doubling; the queue retries after it', async () => {
    const { pid } = await connect();
    const path = `households/${household}/agenda/baby_appointment_a1`;
    await writeDoc(path, { ...(await readDoc(path))!, title: 'Checkup at 18 months', updatedAt: w.clock.now + MIN });
    w.google.failNext = { status: 429, reason: 'rateLimitExceeded', count: 100 };
    await markWork(w.env, pid, SYNC, w.clock.now);
    const first = await runWork(w.env, pid, { fetch: w.fetch, now: w.clock.now });
    expect(first).toEqual({ retryAfter: 30, reason: 'backoff' });
    // Before the back-off ends: nothing asked of Google, and checks skip them.
    const calls = w.google.calls.length;
    expect(await runWork(w.env, pid, { fetch: w.fetch, now: w.clock.now + 10_000 })).toEqual({ retryAfter: 20, reason: 'backoff' });
    expect((await checkPeople(w.env, [pid], { fetch: w.fetch, now: w.clock.now + 10_000 })).skipped).toBe(1);
    expect(w.google.calls.length).toBe(calls);
    w.clock.now += 31_000;
    expect(await runWork(w.env, pid, { fetch: w.fetch, now: w.clock.now })).toEqual({ retryAfter: 60, reason: 'backoff' });
    w.google.failNext = null;
    w.clock.now += 61_000;
    expect(await runWork(w.env, pid, { fetch: w.fetch, now: w.clock.now })).toEqual({ done: true, kind: 'sync', more: true });
    await drain(w);
    expect((await w.env.DB.prepare('SELECT backoff, backoff_until FROM people WHERE pid = ?').bind(pid).first<Record<string, unknown>>())).toEqual({ backoff: 0, backoff_until: null });
  });

  test('Google access removed: one round records it, and the checks don’t queue it again', async () => {
    const { pid } = await connect();
    w.google.revoked.add('g-refresh-good-code');
    const { forgetAccess } = await import('../src/google/oauth');
    forgetAccess();
    expect((await checkPeople(w.env, [pid], { fetch: w.fetch, now: w.clock.now })).marked).toBe(1);
    await drain(w);
    expect((await w.env.DB.prepare('SELECT last_error FROM people WHERE pid = ?').bind(pid).first<{ last_error: string }>())!.last_error).toBe('google-revoked');
    w.clock.now += 5 * MIN;
    expect((await checkPeople(w.env, [pid], { fetch: w.fetch, now: w.clock.now })).marked).toBe(0);
    expect(w.queue).toEqual([]);
  });

  test('a 403 for rate limits backs off too; a 403 for access does not', async () => {
    const { isRateLimited, CalendarApiError } = await import('../src/google/api');
    expect(isRateLimited(new CalendarApiError(403, 'x', 'userRateLimitExceeded'))).toBe(true);
    expect(isRateLimited(new CalendarApiError(403, 'x', 'quotaExceeded'))).toBe(true);
    expect(isRateLimited(new CalendarApiError(403, 'x', 'forbidden'))).toBe(false);
    expect(isRateLimited(new CalendarApiError(429, 'x'))).toBe(true);
  });

  test('the queue refuses (its daily operations used up): the work stays marked and the cron runs it', async () => {
    const { pid, calendarId } = await connect();
    const path = `households/${household}/agenda/baby_appointment_a1`;
    await writeDoc(path, { ...(await readDoc(path))!, title: 'Checkup at 18 months', updatedAt: w.clock.now + MIN });
    w.queueFull.on = true;
    expect(await markWork(w.env, pid, SYNC, w.clock.now)).toBe(false);
    expect((await w.env.DB.prepare('SELECT work, queued_at FROM people WHERE pid = ?').bind(pid).first<Record<string, unknown>>())).toEqual({ work: SYNC, queued_at: null });
    const totals = await runCron(w.env, { fetch: w.fetch, now: w.clock.now });
    expect(totals.worked).toBe(1);
    // Each minute's cron runs MAX_CHAIN units of the round, until it is done.
    for (let m = 1; m <= 3; m++) {
      if ((await w.env.DB.prepare('SELECT work FROM people WHERE pid = ?').bind(pid).first<{ work: number }>())!.work === 0) break;
      await runCron(w.env, { fetch: w.fetch, now: w.clock.now + m * MIN });
    }
    expect((await w.env.DB.prepare('SELECT work FROM people WHERE pid = ?').bind(pid).first<{ work: number }>())!.work).toBe(0);
    expect(w.google.cal(calendarId).events.get((await ids(pid)).checkup)!.summary).toBe('Checkup at 18 months');
  });

  test('Firestore over its daily quota: the checks pause, and the cron starts none until then', async () => {
    const { pid } = await connect();
    const exhausted = async (url: string, init?: RequestInit) =>
      url.includes('/v1/projects/') ? Response.json({ error: { code: 429, message: 'Quota exceeded.', status: 'RESOURCE_EXHAUSTED' } }, { status: 429 }) : w.fetch(url, init);
    const totals = await checkPeople(w.env, [pid], { fetch: exhausted, now: w.clock.now });
    expect(totals.paused).toBe(true);
    let calls = 0;
    const self = w.env.SELF!;
    w.env.SELF = { ...self, check: async (p) => (calls++, self.check(p)) };
    for (let m = 0; m < GOOGLE_EVERY_MIN; m++) await runCron(w.env, { fetch: w.fetch, now: w.clock.now + m * MIN });
    expect(calls).toBe(0);
    w.clock.now += 16 * MIN;
    for (let m = 0; m < GOOGLE_EVERY_MIN; m++) await runCron(w.env, { fetch: w.fetch, now: w.clock.now + m * MIN });
    expect(calls).toBe(1);
  });

  test('more people than one invocation can check: chunks, at most MAX_CALLS invocations, the portal’s last check from the slot', async () => {
    const { pid } = await connect();
    const row = (await w.env.DB.prepare('SELECT shard FROM people WHERE pid = ?').bind(pid).first<{ shard: number }>())!;
    // Invented rows in the same slot (no records: their checks are no-ops).
    for (let i = 0; i < 40; i++) await w.env.DB.prepare('INSERT INTO people (pid, created_at, shard, google, hh) VALUES (?, 0, ?, 1, ?)').bind(`fake${i}`, row.shard, `hh${i % 13}`).run();
    const minute = slotsFor(row.shard, GOOGLE_EVERY_MIN)[0];
    const at = Math.floor(w.clock.now / 3_600_000) * 3_600_000 + minute * MIN + 3_600_000;
    const totals = await runCron(w.env, { fetch: w.fetch, now: at });
    expect(totals.due).toBe(41);
    expect(totals.calls).toBeLessThanOrEqual(MAX_CALLS);
    expect(totals.calls).toBeGreaterThanOrEqual(Math.ceil(41 / CHUNK));
    expect(totals.deferred).toBe(0);
    const status = (await (await call(`/api/status?household=${household}`, 'alice@example.com')).json()) as { google: { lastOk: number } };
    expect(status.google.lastOk).toBe(at);
  });
});

describe('changes made in Google come back', () => {
  test('a one-off moved: the record moves (as the person, under the rules), with history and Undo; no loop', async () => {
    const { pid, calendarId } = await connect();
    const { checkup } = await ids(pid);
    w.clock.now += MIN;
    w.google.userPatch(calendarId, checkup, { start: { dateTime: '2031-10-08T09:00:00+02:00' }, end: { dateTime: '2031-10-08T10:00:00+02:00' } });
    const counts = await later(pid);
    expect(counts.applied).toBe(1);
    expect((await readDoc(`households/${household}/babyAppointments/a1`))!.at).toBe(Date.parse('2031-10-08T09:00:00+02:00'));
    const agenda = (await listDocs(`households/${household}/agenda`)).filter((d) => d.data.ref === 'appointment:a1');
    expect(agenda.map((d) => d.data.start)).toEqual([Date.parse('2031-10-08T09:00:00+02:00')]);
    const [change] = await listDocs(`households/${household}/calendarChanges`);
    expect(change.data).toMatchObject({ email: 'alice@example.com', source: 'google', app: 'baby', change: 'moved', title: 'Checkup' });
    expect(change.data.undo).toContainEqual({ col: 'babyAppointments', id: 'a1', data: expect.objectContaining({ at: Date.parse('2031-10-07T10:30:00+02:00') }) });
    // The next runs see only our own write coming back.
    const next = await later(pid);
    expect(next.applied).toBe(0);
    const after = await later(pid);
    expect(after.applied + after.updated + after.inserted).toBe(0);
    expect(w.google.cal(calendarId).events.get(checkup)!.start!.dateTime).toBe('2031-10-08T09:00:00');
  });

  test('one occurrence deleted: skipped in Home, gone from the series', async () => {
    const { pid, calendarId } = await connect();
    const { bins } = await ids(pid);
    const cal = w.google.cal(calendarId);
    const master = cal.events.get(bins)!;
    w.clock.now += MIN;
    w.google.userInstance(calendarId, bins, '20311009T050000Z', { status: 'cancelled' });
    const counts = await later(pid);
    expect(counts.applied).toBe(1);
    const event = (await readDoc(`households/${household}/homeEvents/bins`))!;
    expect(event.exceptions).toEqual({ '2031-10-16': { skipped: true }, '2031-10-09': { skipped: true } });
    expect(cal.events.get(bins)!.recurrence![1]).toBe('EXDATE;TZID=Europe/Amsterdam:20311009T070000,20311016T070000');
    expect(master.id).toBe(bins);
  });

  test('one occurrence moved: moved in Home; moved back later, the instance follows', async () => {
    const { pid, calendarId } = await connect();
    const { bins } = await ids(pid);
    w.clock.now += MIN;
    w.google.userInstance(calendarId, bins, '20311023T050000Z', { start: { dateTime: '2031-10-24T08:00:00+02:00' }, end: { dateTime: '2031-10-24T08:30:00+02:00' } });
    await later(pid);
    const event = (await readDoc(`households/${household}/homeEvents/bins`))!;
    expect((event.exceptions as Record<string, unknown>)['2031-10-23']).toEqual({ moved: { date: '2031-10-24', time: '08:00' } });
    const moved = (await listDocs(`households/${household}/agenda`)).find((d) => d.data.ref === 'event:bins' && (d.data.series as { original: string }).original === '2031-10-23')!;
    expect(moved.data.start).toBe(Date.parse('2031-10-24T08:00:00+02:00'));
    const instance = w.google.cal(calendarId).events.get(instanceId(bins, { rule: { freq: 'week', every: 1, start: '2031-09-04' }, time: '07:00', minutes: 30, first: '2031-09-04', exdates: [], overrides: [] }, '2031-10-23', TZ))!;
    expect(instance.start!.dateTime).toContain('2031-10-24T08:00');
  });

  test('the whole series renamed: the regular event is renamed', async () => {
    const { pid, calendarId } = await connect();
    const { bins } = await ids(pid);
    w.clock.now += MIN;
    w.google.userPatch(calendarId, bins, { summary: 'Bins and recycling' });
    await later(pid);
    expect((await readDoc(`households/${household}/homeEvents/bins`))!.title).toBe('Bins and recycling');
    const items = (await listDocs(`households/${household}/agenda`)).filter((d) => d.data.ref === 'event:bins');
    expect(new Set(items.map((d) => d.data.title))).toEqual(new Set(['Bins and recycling']));
  });

  test('notes typed in Google go to the record', async () => {
    const { pid, calendarId } = await connect();
    const { checkup } = await ids(pid);
    w.clock.now += MIN;
    w.google.userPatch(calendarId, checkup, { description: 'Clinic\n\nBring the vaccination card\n\nhttps://huishouden-piekstra.web.app/baby/' });
    await later(pid);
    expect((await readDoc(`households/${household}/babyAppointments/a1`))!.notes).toBe('Bring the vaccination card');
  });

  test('a one-off deleted in Google: cancelled in the app', async () => {
    const { pid, calendarId } = await connect();
    w.clock.now += MIN;
    w.google.userDelete(calendarId, (await ids(pid)).checkup);
    await later(pid);
    expect(await readDoc(`households/${household}/babyAppointments/a1`)).toBeNull();
    const [change] = await listDocs(`households/${household}/calendarChanges`);
    expect(change.data.change).toBe('cancelled');
  });

  test('the whole series deleted: out of their calendar only; the household keeps it', async () => {
    const { pid, calendarId } = await connect();
    const { bins } = await ids(pid);
    w.clock.now += MIN;
    w.google.userDelete(calendarId, bins);
    const counts = await later(pid);
    expect(counts.hidden).toBe(1);
    expect(await readDoc(`households/${household}/homeEvents/bins`)).not.toBeNull();
    await later(pid, 60 * 7);
    expect(w.google.cal(calendarId).events.get(bins)!.status).toBe('cancelled');
  });

  test('conflict: the app changed it after Google did: the app wins and Google is put back', async () => {
    const { pid, calendarId } = await connect();
    const { checkup } = await ids(pid);
    const changedAt = w.clock.now + MIN;
    w.google.userPatch(calendarId, checkup, { start: { dateTime: '2031-10-09T09:00:00+02:00' }, end: { dateTime: '2031-10-09T10:00:00+02:00' } }, changedAt);
    const path = `households/${household}/agenda/baby_appointment_a1`;
    await writeDoc(path, { ...(await readDoc(path))!, detail: 'Clinic, room 4', updatedAt: changedAt + MIN });
    const counts = await later(pid);
    expect(counts.conflicts).toBe(1);
    expect((await readDoc(`households/${household}/babyAppointments/a1`))!.at).toBe(Date.parse('2031-10-07T10:30:00+02:00'));
    expect(w.google.cal(calendarId).events.get(checkup)!.start!.dateTime).toBe('2031-10-07T10:30:00');
  });

  test('what the person may not change is put back, and the portal is told', async () => {
    // Helen (a helper) may move appointments by the item's edit, but the rules let her change only
    // what she added; Bob added this one.
    const { pid, calendarId } = await connect('helen@example.com');
    const { checkup } = await ids(pid);
    w.clock.now += MIN;
    w.google.userPatch(calendarId, checkup, { start: { dateTime: '2031-10-08T09:00:00+02:00' }, end: { dateTime: '2031-10-08T10:00:00+02:00' } });
    const counts = await later(pid);
    expect(counts.refused).toBe(1);
    expect((await readDoc(`households/${household}/babyAppointments/a1`))!.at).toBe(Date.parse('2031-10-07T10:30:00+02:00'));
    expect(w.google.cal(calendarId).events.get(checkup)!.start!.dateTime).toBe('2031-10-07T10:30:00');
    const status = (await (await call(`/api/status?household=${household}`, 'helen@example.com')).json()) as { google: { notice: string } };
    expect(status.google.notice).toBe('refused:1');
  });

  test('a run that wrote to Firestore but not its own state is retried without applying twice', async () => {
    const { pid, calendarId } = await connect();
    const { checkup } = await ids(pid);
    w.clock.now += MIN;
    w.google.userPatch(calendarId, checkup, { summary: 'Checkup (moved room)' });
    // The Worker's own state as it was before the run, put back after it: as if it stopped after
    // the Firestore commit and before saving its state.
    const people = await w.env.DB.prepare('SELECT * FROM people WHERE pid = ?').bind(pid).first<Record<string, unknown>>();
    const rows = (await w.env.DB.prepare('SELECT * FROM events WHERE pid = ?').bind(pid).all<Record<string, unknown>>()).results;
    await later(pid);
    await w.env.DB.prepare('DELETE FROM events WHERE pid = ?').bind(pid).run();
    for (const r of rows) await w.env.DB.prepare('INSERT INTO events (pid, key, event_id, hash, etag, overrides, written, hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(r.pid, r.key, r.event_id, r.hash, r.etag, r.overrides, r.written, r.hidden).run();
    await w.env.DB.prepare('UPDATE people SET sync_token = ?, signal = ?, full_at = ? WHERE pid = ?').bind(people!.sync_token, people!.signal, people!.full_at, pid).run();
    await later(pid);
    expect((await listDocs(`households/${household}/calendarChanges`)).length).toBe(1);
    expect((await readDoc(`households/${household}/babyAppointments/a1`))!.title).toBe('Checkup (moved room)');
    expect(w.google.cal(calendarId).events.get(checkup)!.summary).toBe('Checkup (moved room)');
  });
});

describe('disconnecting', () => {
  test('deletes the calendar when asked, revokes Google’s grant, forgets the tokens', async () => {
    const { pid, calendarId } = await connect();
    const res = await call('/api/google/disconnect', 'alice@example.com', { household, deleteCalendar: true });
    expect(res.status).toBe(200);
    expect(w.google.calendars.has(calendarId)).toBe(false);
    expect(w.google.revoked.has('g-refresh-good-code')).toBe(true);
    expect(await loadPerson(w.env, pid)).toBeNull();
    expect((await w.env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE pid = ?').bind(pid).first<{ n: number }>())!.n).toBe(0);
  });

  test('keeps the calendar when asked to, and the feed when there is one', async () => {
    await call('/api/feed', 'alice@example.com', { household, refreshToken: refreshFor('alice@example.com'), lang: 'en', timeZone: TZ });
    const { pid, calendarId } = await connect();
    await call('/api/google/disconnect', 'alice@example.com', { household, deleteCalendar: false });
    expect(w.google.calendars.has(calendarId)).toBe(true);
    const record = await loadPerson(w.env, pid);
    expect(record?.google).toBeUndefined();
    expect(record?.feed).toBeDefined();
  });

  test('the calendar deleted in Google: syncing stops and the portal says so', async () => {
    const { pid, calendarId } = await connect();
    w.google.calendars.delete(calendarId);
    await later(pid);
    const status = (await (await call(`/api/status?household=${household}`, 'alice@example.com')).json()) as { google: unknown; lastError: string };
    expect(status.google).toBeNull();
    expect(status.lastError).toBe('calendar-deleted');
  });
});
