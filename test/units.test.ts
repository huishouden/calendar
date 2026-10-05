import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { exportEvents, exportIcs, loadExportLang, type ExportEvent } from '@huishouden/pwa-kit/calendar-export';
import { icsProblems } from '@huishouden/pwa-kit/ics';
import { handleApi } from '../src/api';
import { Person } from '../src/person';
import { assembleIcs, eventIcs, keepWitness, partition, ROUND_MAX_MS, UNIT_CALLS, UNIT_ITEMS } from '../src/round';
import { MAX_WRITES } from '../src/sync';
import { FEED, MAX_CHAIN, runWork, SYNC, markWork, type Handover } from '../src/work';
import { checkPeople } from '../src/check';
import { loadPerson, openFeedBody, personId } from '../src/store';
import { captureLogs } from '../src/log';
import { apiRequest, drain, household, refreshFor, resetFirestore, seed, world, TZ, type World } from './helpers/world';

// A feed build and a sync round go in units (src/round.ts), each within the free plan's 10 ms of
// CPU: a bounded number of subrequests and of items. Cut up, they come to exactly what the whole
// would: the same events, the same feed byte for byte, the same calendar in Google.

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
const call = (path: string, email: string, body?: Record<string, unknown>) => handleApi(w.env, apiRequest(path, email, body), undefined, { fetch: w.fetch, now: w.clock.now });

/** A busy invented household on top of the fixture: series with moved occurrences, one-offs, to-dos. */
async function busy({ series = 12, singles = 110, todos = 20 } = {}): Promise<void> {
  const docs: Record<string, unknown> = {};
  const day = (d: number) => new Date(Date.UTC(2031, 9, 2 + d, 8)).toISOString().replace('.000Z', 'Z');
  for (let s = 0; s < series; s++) {
    for (let k = 0; k < 4; k++) {
      const original = new Date(Date.UTC(2031, 9, 2 + 7 * k)).toISOString().slice(0, 10);
      const moved = k === 2 && s % 3 === 0;
      docs[`households/h1/agenda/home_event_s${s}_${k}`] = {
        app: 'home', ref: `event:s${s}`, kind: 'other', title: `Series ${s}`, start: moved ? day(7 * k + 1) : `${original}T09:00:00+02:00`, end: moved ? day(7 * k + 1).replace('T08', 'T09') : `${original}T10:00:00+02:00`, allDay: false,
        url: 'https://huishouden-piekstra.web.app/home/', private: s % 5 === 0, series: { rule: { freq: 'week', every: 1, start: '2031-09-04' }, time: '09:00', minutes: 60, original, through: '2031-10-30' },
        updatedAt: Date.parse('2031-09-30T12:00:00Z') + s, by: 'alice@example.com',
      };
    }
  }
  for (let i = 0; i < singles; i++) {
    docs[`households/h1/agenda/baby_appointment_x${i}`] = {
      app: i % 2 ? 'baby' : 'pet', ref: `appointment:x${i}`, kind: 'appointment', title: `Visit ${i}`, detail: 'Bring the card.', start: day(i % 60), end: day(i % 60).replace('T08', 'T09'), allDay: i % 7 === 0,
      url: 'https://huishouden-piekstra.web.app/baby/', private: i % 9 === 0, updatedAt: Date.parse('2031-09-30T12:00:00Z') + i, by: 'bob@example.com',
    };
  }
  for (let t = 0; t < todos; t++) {
    docs[`households/h1/todos/tasks:item:t${t}`] = { app: 'tasks', ref: `item:t${t}`, title: `Task ${t}`, createdAt: 1, due: day(t), url: 'https://huishouden-piekstra.web.app/tasks/', status: 'open', private: false, updatedAt: Date.parse('2031-09-30T12:00:00Z') + t, by: 'bob@example.com' };
  }
  await seed(docs);
}

const loadAs = async (email: string) => {
  const p = new Person(w.env, { household, email, refreshToken: refreshFor(email) }, w.fetch);
  const view = await p.view();
  return { view, loaded: await p.load(view, w.clock.now) };
};

const sortEvents = (events: ExportEvent[]) => [...events].sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
const summary = (events: ExportEvent[]) => events.map((e) => [e.key, e.hash]);

describe('the export in parts', () => {
  test('is the export of the whole, for every role, parts of at most UNIT_ITEMS (a record’s items together)', async () => {
    await busy();
    await loadExportLang('en');
    for (const email of ['alice@example.com', 'helen@example.com', 'kim@example.com']) {
      const { view, loaded } = await loadAs(email);
      const input = { me: email, role: view.role, lang: 'en' as const, timeZone: TZ, settings: view.settings };
      const whole = exportEvents({ ...input, agenda: loaded.agenda, todos: loaded.todos });
      for (const size of [1, 7, UNIT_ITEMS]) {
        const parts = partition(loaded, input, size);
        for (const p of parts) {
          const groups = new Set(p.agenda.map((i) => `${i.app}|${i.ref}`));
          if (groups.size > 1 || p.todos.length) expect(p.agenda.length + p.todos.length).toBeLessThanOrEqual(size);
        }
        const cut = sortEvents(parts.flatMap((p) => exportEvents({ ...input, agenda: p.agenda, todos: p.todos })));
        expect(summary(cut)).toEqual(summary(whole));
      }
      expect(whole.length).toBeGreaterThan(view.restricted ? 10 : 100);
    }
  });

  test('the feed put together from its parts is exportIcs of the whole, byte for byte', async () => {
    await busy();
    await loadExportLang('en');
    const { view, loaded } = await loadAs('alice@example.com');
    for (const timeZone of [TZ, 'UTC', 'America/Chicago']) {
      const input = { me: 'alice@example.com', role: view.role, lang: 'en' as const, timeZone, settings: view.settings };
      const options = { householdId: household, timeZone, lang: 'en' as const, now: w.clock.now };
      const whole = exportEvents({ ...input, agenda: loaded.agenda, todos: loaded.todos });
      for (const pick of [(e: ExportEvent[]) => e, (e: ExportEvent[]) => e.filter((x) => x.allDay), () => [] as ExportEvent[]]) {
        const events = pick(whole);
        const expected = exportIcs(events, options);
        let witness: ExportEvent[] = [];
        const pieces = [];
        // In parts of 9, in reverse: the order the parts come in doesn't matter.
        for (let i = events.length; i > 0; i -= 9) {
          const part = events.slice(Math.max(0, i - 9), i);
          witness = keepWitness(witness, part, household, timeZone, 'en');
          pieces.push(...part.map((e) => ({ s: e.start, k: e.key, t: eventIcs(e, options) })));
        }
        const built = assembleIcs(pieces, witness, options);
        expect(built).toBe(expected);
        expect(icsProblems(built)).toEqual([]);
      }
    }
  });
});

describe('a busy household, in units', () => {
  test('feed and Google: every unit within UNIT_CALLS and MAX_WRITES; the feed and the calendar as from the whole', async () => {
    await busy();
    const logs = captureLogs();
    await call('/api/feed', 'alice@example.com', { household, refreshToken: refreshFor('alice@example.com'), lang: 'en', timeZone: TZ });
    const res = await call('/api/google/connect', 'alice@example.com', { household, code: 'good-code', refreshToken: refreshFor('alice@example.com'), lang: 'en', timeZone: TZ });
    expect(res.status).toBe(200);
    await drain(w);
    logs.restore();
    const units = logs.lines.map((l) => JSON.parse(l) as { event: string; ok?: boolean; calls?: number; step?: string; kind?: string }).filter((l) => l.event === 'work');
    expect(units.length).toBeGreaterThan(10);
    for (const u of units) {
      expect(u.ok).toBe(true);
      expect(u.calls!).toBeLessThanOrEqual(UNIT_CALLS);
    }
    // Each Google batch: at most MAX_WRITES writes.
    let parts = -1;
    const sizes: number[] = [];
    for (const c of w.google.calls) {
      if (c === 'POST /batch') {
        if (parts >= 0) sizes.push(parts);
        parts = 0;
      } else if (c.startsWith('  ') && parts >= 0) parts++;
      else if (parts >= 0) {
        sizes.push(parts);
        parts = -1;
      }
    }
    if (parts >= 0) sizes.push(parts);
    expect(sizes.length).toBeGreaterThan(5);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_WRITES);

    const pid = await personId(household, 'alice@example.com');
    const record = (await loadPerson(w.env, pid))!;
    const { view, loaded } = await loadAs('alice@example.com');
    await loadExportLang('en');
    const whole = exportEvents({ agenda: loaded.agenda, todos: loaded.todos, me: 'alice@example.com', role: view.role, lang: 'en', timeZone: TZ, settings: view.settings });
    // The feed: exactly exportIcs of everything.
    const row = (await w.env.DB.prepare('SELECT body FROM feeds WHERE pid = ?').bind(pid).first<{ body: string }>())!;
    const body = await openFeedBody(w.env, record.feed!.secret, row.body);
    expect(body).toBe(exportIcs(whole, { householdId: household, timeZone: TZ, lang: 'en', now: w.clock.now }));
    // Google: one event for each, and one for each moved occurrence of a series.
    expect(w.google.live(record.google!.calendarId).length).toBe(whole.reduce((n, e) => n + 1 + (e.series?.overrides.length ?? 0), 0));
    // Nothing of the rounds is left behind.
    expect((await w.env.DB.prepare('SELECT COUNT(*) AS n FROM round_items').first<{ n: number }>())!.n).toBe(0);
    expect((await w.env.DB.prepare('SELECT COUNT(*) AS n FROM people WHERE round IS NOT NULL').first<{ n: number }>())!.n).toBe(0);
  });

  test('items gone from the household go from Google, deletions first, in units of MAX_WRITES', async () => {
    await busy({ series: 0, singles: 30, todos: 0 });
    await call('/api/google/connect', 'alice@example.com', { household, code: 'good-code', refreshToken: refreshFor('alice@example.com'), lang: 'en', timeZone: TZ });
    await drain(w);
    const pid = await personId(household, 'alice@example.com');
    const calendarId = (await loadPerson(w.env, pid))!.google!.calendarId;
    const before = w.google.live(calendarId).length;
    await resetFirestore();
    await seed();
    w.clock.now += MIN;
    await markWork(w.env, pid, SYNC, w.clock.now);
    await drain(w);
    expect(w.google.live(calendarId).length).toBe(before - 30);
    expect(w.google.live(calendarId).some((e) => e.summary?.startsWith('Visit '))).toBe(false);
  });

  test('a round left half way for longer than ROUND_MAX_MS starts again from the top', async () => {
    await busy({ series: 2, singles: 100, todos: 0 });
    await call('/api/feed', 'alice@example.com', { household, refreshToken: refreshFor('alice@example.com'), lang: 'en', timeZone: TZ });
    await drain(w);
    const pid = await personId(household, 'alice@example.com');
    await markWork(w.env, pid, FEED, w.clock.now);
    w.queue.length = 0;
    // Two units of a new build, then nothing for a while.
    await runWork(w.env, pid, { fetch: w.fetch, now: w.clock.now });
    await runWork(w.env, pid, { fetch: w.fetch, now: w.clock.now });
    w.queue.length = 0;
    expect((await w.env.DB.prepare('SELECT round_kind FROM people WHERE pid = ?').bind(pid).first<{ round_kind: number }>())!.round_kind).toBe(FEED);
    w.clock.now += ROUND_MAX_MS + MIN;
    const logs = captureLogs();
    await runWork(w.env, pid, { fetch: w.fetch, now: w.clock.now });
    logs.restore();
    const first = logs.lines.map((l) => JSON.parse(l) as { event: string; step?: string }).find((l) => l.event === 'work')!;
    expect(first.step!.startsWith('view')).toBe(true);
    await drain(w);
    expect((await w.env.DB.prepare('SELECT built_at FROM feeds WHERE pid = ?').bind(pid).first<{ built_at: number }>())!.built_at).toBe(w.clock.now);
  });

  test('a long round: MAX_CHAIN units one from another, then the queue takes the next', async () => {
    await busy({ series: 0, singles: 120, todos: 0 });
    const res = await call('/api/google/connect', 'alice@example.com', { household, code: 'good-code', refreshToken: refreshFor('alice@example.com'), lang: 'en', timeZone: TZ });
    expect(res.status).toBe(200);
    const pid = await personId(household, 'alice@example.com');
    // The first sync, queued by the connect, run here: 120 inserts are more units than one chain.
    expect(w.queue).toEqual([{ pid }]);
    w.queue.length = 0;
    const depths: number[] = [];
    const self = w.env.SELF!;
    w.env.SELF = { ...self, work: async (p, h) => (depths.push(h?.depth ?? 0), self.work(p, h)) };
    await runWork(w.env, pid, { fetch: w.fetch, now: w.clock.now, next: (p, h) => w.env.SELF!.work(p, h) });
    expect(Math.max(...depths)).toBe(MAX_CHAIN - 1);
    expect(w.queue).toEqual([{ pid }]);
    // The person is let go between chains: the queue's unit takes them.
    expect((await w.env.DB.prepare('SELECT lease_until FROM people WHERE pid = ?').bind(pid).first<{ lease_until: number | null }>())!.lease_until).toBeNull();
    await drain(w);
    expect(w.google.live((await loadPerson(w.env, pid))!.google!.calendarId).filter((e) => e.summary?.startsWith('Visit ')).length).toBe(120);
  });

  test('after a check: the round reads the lists by the aggregations the check asked, not asking them again', async () => {
    await busy({ series: 2, singles: 30, todos: 0 });
    await call('/api/feed', 'alice@example.com', { household, refreshToken: refreshFor('alice@example.com'), lang: 'en', timeZone: TZ });
    await drain(w);
    const pid = await personId(household, 'alice@example.com');
    await seed({ 'households/h1/agenda/baby_appointment_x3': { app: 'baby', ref: 'appointment:x3', kind: 'appointment', title: 'Moved visit', start: Date.parse('2031-10-09T10:00:00Z'), end: Date.parse('2031-10-09T11:00:00Z'), allDay: false, url: 'https://huishouden-piekstra.web.app/baby/', private: false, updatedAt: w.clock.now + MIN, by: 'bob@example.com' } });
    w.clock.now += 2 * MIN;
    const asked: string[] = [];
    const counting = (url: string, init?: RequestInit) => (url.includes(':runAggregationQuery') && asked.push(url), w.fetch(url, init));
    expect((await checkPeople(w.env, [pid], { fetch: counting, now: w.clock.now })).marked).toBe(1);
    const byCheck = asked.length;
    expect(byCheck).toBeGreaterThan(0);
    w.queue.length = 0;
    await runWork(w.env, pid, { fetch: counting, now: w.clock.now, next: (p, h) => runWork(w.env, p, { fetch: counting, now: w.clock.now, handover: h, next: (q, k) => w.env.SELF!.work(q, k) }) });
    await drain(w);
    expect(asked.length).toBe(byCheck);
    const body = await openFeedBody(w.env, (await loadPerson(w.env, pid))!.feed!.secret, (await w.env.DB.prepare('SELECT body FROM feeds WHERE pid = ?').bind(pid).first<{ body: string }>())!.body);
    expect(body).toContain('SUMMARY:Moved visit');
  });

  test('an invocation lost after its writes: the unit runs again, adding nothing twice; the feed as from the whole', async () => {
    await busy({ series: 3, singles: 140, todos: 10 });
    await call('/api/feed', 'alice@example.com', { household, refreshToken: refreshFor('alice@example.com'), lang: 'en', timeZone: TZ });
    await drain(w);
    const pid = await personId(household, 'alice@example.com');
    await w.env.DB.prepare('DELETE FROM feeds').run();
    await markWork(w.env, pid, FEED, w.clock.now, { queue: false });
    // Every third unit in the chain is "lost" once its writes are made: its caller hears nothing back.
    const self = w.env.SELF!;
    let n = 0;
    w.env.SELF = { ...self, work: async (p: string, h?: Handover) => { const r = await self.work(p, h); if (++n % 3 === 0) throw new Error('invocation lost'); return r; } };
    await runWork(w.env, pid, { fetch: w.fetch, now: w.clock.now, next: (p, h) => w.env.SELF!.work(p, h) });
    w.env.SELF = self;
    await drain(w);
    for (let i = 0; i < 5 && (await w.env.DB.prepare('SELECT work FROM people WHERE pid = ?').bind(pid).first<{ work: number }>())!.work; i++) {
      await markWork(w.env, pid, 0, w.clock.now);
      await drain(w);
    }
    const { view, loaded } = await loadAs('alice@example.com');
    await loadExportLang('en');
    const whole = exportEvents({ agenda: loaded.agenda, todos: loaded.todos, me: 'alice@example.com', role: view.role, lang: 'en', timeZone: TZ, settings: view.settings });
    const row = (await w.env.DB.prepare('SELECT body FROM feeds WHERE pid = ?').bind(pid).first<{ body: string }>())!;
    const body = await openFeedBody(w.env, (await loadPerson(w.env, pid))!.feed!.secret, row.body);
    const started = (await w.env.DB.prepare('SELECT built_at FROM feeds WHERE pid = ?').bind(pid).first<{ built_at: number }>())!.built_at;
    expect(body).toBe(exportIcs(whole, { householdId: household, timeZone: TZ, lang: 'en', now: started }));
    expect((await w.env.DB.prepare('SELECT COUNT(*) AS n FROM round_items').first<{ n: number }>())!.n).toBe(0);
  });
});
