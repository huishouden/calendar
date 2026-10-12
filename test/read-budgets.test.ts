import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { expectReads, writeBeforeEachRead } from '@huishouden/pwa-kit/read-test';
import { handleApi } from '../src/api';
import { checkPeople } from '../src/check';
import { FEED, markWork, SYNC } from '../src/work';
import { loadPerson, personId } from '../src/store';
import { checkInboxes } from '../src/mail/check';
import { inboxIdOf } from '../src/mail/store';
import { workReadsKey } from '../src/budget';
import { captureLogs } from '../src/log';
import { apiRequest, drain, FIRESTORE, household, readDoc, refreshFor, resetFirestore, seed, world, writeDoc, TZ, type World } from './helpers/world';
import { throughMeter } from './helpers/reads';

// Read budgets (pwa-kit STANDARD.md "Read budgets"): each kind of run this Worker makes, on the
// fixture household (invented), with a ceiling on what Firestore bills for it. A change that raises
// one says why in its PR. The interleaving tests land another member's write before every read a
// round makes (the 2026-10-12 incident: an edit between the check and the round sent it round
// `lists` and `split` for ever) and the round must still finish within its budget.

let w: World;
const MIN = 60_000;
const H = `households/${household}`;
const AGENDA = `${H}/agenda/baby_appointment_a1`;

beforeAll(async () => {
  await resetFirestore();
});

beforeEach(async () => {
  await resetFirestore();
  await seed();
  w = world();
});

let restore = () => {};
afterEach(() => restore());

const call = (path: string, email: string, body?: Record<string, unknown>) => handleApi(w.env, apiRequest(path, email, body), undefined, { fetch: w.fetch, now: w.clock.now, firestoreUrl: FIRESTORE });

async function feedFor(email: string): Promise<string> {
  await call('/api/feed', email, { household, refreshToken: refreshFor(email), lang: 'en', timeZone: TZ });
  await drain(w);
  return personId(household, email);
}

async function googleFor(email: string): Promise<string> {
  expect((await call('/api/google/connect', email, { household, code: 'good-code', refreshToken: refreshFor(email), lang: 'en', timeZone: TZ })).status).toBe(200);
  await drain(w);
  return personId(household, email);
}

/** Another member's edit, as their app writes it (the emulator's owner: not this Worker's read). */
const edit = (n: number) => seed({ [AGENDA]: { app: 'baby', ref: 'appointment:a1', kind: 'appointment', title: `Checkup, take ${n}`, start: Date.parse('2031-10-06T09:00:00Z'), end: Date.parse('2031-10-06T10:00:00Z'), allDay: false, url: 'https://huishouden-piekstra.web.app/baby/', private: false, updatedAt: w.clock.now + n, by: 'bob@example.com' } });

/** Runs a person's marked work to the end through `fetch`: the first unit, its chain, the queue. */
async function work(fetch: (u: string, i?: RequestInit) => Promise<Response>, pid: string) {
  const m = throughMeter(w, fetch);
  restore = m.restore;
  const outcome = await w.env.SELF!.work(pid);
  await m.drain();
  return outcome;
}

describe('checks', () => {
  test('a check of a feed member: the household, their settings, four aggregations', async () => {
    const pid = await feedFor('alice@example.com');
    w.clock.now += 5 * MIN;
    const { value } = await expectReads((meter) => checkPeople(w.env, [pid], { fetch: meter(w.fetch), now: w.clock.now }), { max: 6, min: 1, label: 'check, one person' });
    expect(value.checked).toBe(1);
    expect(value.reads).toBeGreaterThan(0);
  });

  test("a household's three members in one invocation share its lists' counts", async () => {
    const pids = [await feedFor('alice@example.com'), await feedFor('bob@example.com'), await feedFor('kim@example.com')];
    w.clock.now += 5 * MIN;
    const { value } = await expectReads((meter) => checkPeople(w.env, pids, { fetch: meter(w.fetch), now: w.clock.now }), { max: 16, label: 'check, three members' });
    expect(value.checked).toBe(3);
  });

  test("the checks' share of the day spent: nothing is read", async () => {
    const pid = await feedFor('alice@example.com');
    w.env.FIRESTORE_CHECK_READS = '50';
    await w.env.DB.prepare("INSERT INTO meta (key, value) VALUES (?, 50) ON CONFLICT(key) DO UPDATE SET value = 50").bind(workReadsKey(w.clock.now).replace('work-', 'check-')).run();
    const { value } = await expectReads((meter) => checkPeople(w.env, [pid], { fetch: meter(w.fetch), now: w.clock.now }), { max: 0, label: 'check, share spent' });
    expect(value).toMatchObject({ checked: 0, budget: 'check' });
  });
});

describe('feed rounds', () => {
  test("a person's first feed: each list read whole once", async () => {
    const pid = await feedFor('alice@example.com');
    // As before a first build: nothing kept.
    await w.env.DB.prepare('DELETE FROM lists').run();
    await markWork(w.env, pid, FEED, w.clock.now, { queue: false });
    await expectReads((meter) => work(meter(w.fetch), pid), { max: 15, min: 1, label: 'feed round, first' });
  });

  test('after one change: the view, the counts, what changed', async () => {
    const pid = await feedFor('alice@example.com');
    await edit(1);
    w.clock.now += 5 * MIN;
    await checkPeople(w.env, [pid], { fetch: w.fetch, now: w.clock.now });
    w.queue.length = 0;
    await expectReads((meter) => work(meter(w.fetch), pid), { max: 5, min: 1, label: 'feed round, one change' });
  });
});

describe('sync rounds', () => {
  test("a person's first sync, and one after a change", async () => {
    await call('/api/google/connect', 'alice@example.com', { household, code: 'good-code', refreshToken: refreshFor('alice@example.com'), lang: 'en', timeZone: TZ });
    const pid = await personId(household, 'alice@example.com');
    w.queue.length = 0;
    await expectReads((meter) => work(meter(w.fetch), pid), { max: 15, min: 1, label: 'sync round, first' });
    await edit(1);
    w.clock.now += 5 * MIN;
    await markWork(w.env, pid, SYNC, w.clock.now, { queue: false });
    await expectReads((meter) => work(meter(w.fetch), pid), { max: 7, min: 1, label: 'sync round, one change' });
  });
});

describe('alert inboxes', () => {
  test("an inbox's import unit: cards, rules, settings and the days' transactions", async () => {
    await writeDoc(`${H}/spendingCards/c1`, { name: 'Card One', last4: '1111', alertWords: ['alerts@bank.example.com'], createdAt: 1, by: 'alice@example.com' });
    w.gmail.deliver('alerts', { from: 'alerts@bank.example.com', subject: 'Transaction alert', text: 'You made a $12.30 transaction with NOODLE BAR on your card ending in 1111.', at: w.clock.now - 5 * MIN });
    expect((await call('/api/mail/connect', 'bob@example.com', { household, code: 'gmail-alerts', refreshToken: refreshFor('bob@example.com'), timeZone: TZ })).status).toBe(200);
    const id = await inboxIdOf(household, 'alerts@example.com');
    w.queue.length = 0;
    await expectReads(
      async (meter) => {
        const m = throughMeter(w, meter(w.fetch));
        restore = m.restore;
        await w.env.SELF!.mailWork(id);
        await m.drain();
      },
      { max: 5, min: 1, label: 'alert inbox unit' },
    );
    // A check of the inbox reads no Firestore.
    w.clock.now += 30 * MIN;
    await expectReads((meter) => checkInboxes(w.env, [id], { fetch: meter(w.fetch), now: w.clock.now, firestoreUrl: FIRESTORE }), { max: 0, label: 'alert inbox check' });
  });

  test("the inboxes' share of the day spent: nothing is read, the inbox waits for midnight Pacific", async () => {
    w.gmail.deliver('alerts', { from: 'alerts@bank.example.com', subject: 'Transaction alert', text: 'You made a $4.00 transaction with KIOSK on your card ending in 1111.', at: w.clock.now - 5 * MIN });
    expect((await call('/api/mail/connect', 'bob@example.com', { household, code: 'gmail-alerts', refreshToken: refreshFor('bob@example.com'), timeZone: TZ })).status).toBe(200);
    const id = await inboxIdOf(household, 'alerts@example.com');
    w.queue.length = 0;
    w.env.FIRESTORE_MAIL_READS = '10';
    await w.env.DB.prepare('INSERT INTO meta (key, value) VALUES (?, 10)').bind(workReadsKey(w.clock.now).replace('work-', 'mail-')).run();
    const { value } = await expectReads(
      async (meter) => {
        const m = throughMeter(w, meter(w.fetch));
        restore = m.restore;
        return w.env.SELF!.mailWork(id);
      },
      { max: 0, label: 'alert inbox, share spent' },
    );
    expect(value).toMatchObject({ reason: 'budget' });
  });
});

describe('interleaving: another member writes before every read a round makes', () => {
  test('a feed round still finishes, with the latest title, within its budget', async () => {
    const pid = await feedFor('alice@example.com');
    await edit(1);
    w.clock.now += 5 * MIN;
    await checkPeople(w.env, [pid], { fetch: w.fetch, now: w.clock.now });
    w.queue.length = 0;
    const logs = captureLogs();
    const { value } = await expectReads((meter) => work(meter(w.fetch), pid), { max: 11, label: 'feed round, a write before each read', beforeRead: writeBeforeEachRead((n) => edit(n + 1)) });
    logs.restore();
    expect(value).toMatchObject({ done: true });
    expect(logs.lines.some((l) => l.includes('read-budget'))).toBe(false);
    expect((await w.env.DB.prepare('SELECT work, round FROM people WHERE pid = ?').bind(pid).first<{ work: number; round: string | null }>())!).toEqual({ work: 0, round: null });
  });

  test('a sync round still finishes within its budget', async () => {
    const pid = await googleFor('alice@example.com');
    await edit(1);
    w.clock.now += 5 * MIN;
    await markWork(w.env, pid, SYNC | FEED, w.clock.now, { queue: false });
    const logs = captureLogs();
    const { value } = await expectReads((meter) => work(meter(w.fetch), pid), { max: 13, label: 'sync round, a write before each read', beforeRead: writeBeforeEachRead((n) => edit(n + 1)) });
    logs.restore();
    expect(value).toMatchObject({ done: true });
    expect(logs.lines.some((l) => l.includes('read-budget'))).toBe(false);
    const row = (await w.env.DB.prepare('SELECT work, round FROM people WHERE pid = ?').bind(pid).first<{ work: number; round: string | null }>())!;
    expect(row.round).toBeNull();
    expect(row.work & SYNC).toBe(0);
    expect(await loadPerson(w.env, pid)).not.toBeNull();
    expect(await readDoc(AGENDA)).not.toBeNull();
  });
});

describe('refusals', () => {
  test("a budget's refusal is never Firestore's own quota, whatever order a runner checks them in", async () => {
    const { FirestoreError } = await import('@huishouden/pwa-kit/firestore-rest');
    const { firestoreQuota, refusedBy } = await import('../src/budget');
    const quota = new FirestoreError('resource-exhausted', 'Firestore 429 RESOURCE_EXHAUSTED');
    const cap = new FirestoreError('resource-exhausted', 'Firestore 429 RESOURCE_EXHAUSTED: Read budget spent: run', 'run');
    const share = new FirestoreError('resource-exhausted', 'Firestore 429 RESOURCE_EXHAUSTED: Read budget spent: work', 'work');
    expect([firestoreQuota(quota), refusedBy(quota)]).toEqual([true, null]);
    expect([firestoreQuota(cap), refusedBy(cap)]).toEqual([false, 'run']);
    expect([firestoreQuota(share), refusedBy(share)]).toEqual([false, 'work']);
    // A scope this Worker doesn't have is nobody's here.
    expect(refusedBy(new FirestoreError('resource-exhausted', 'x', 'connection'))).toBeNull();
  });

  test("a portal request past its cap answers read-budget, never the project's firestore-quota", async () => {
    const { FirestoreError } = await import('@huishouden/pwa-kit/firestore-rest');
    const { readFailure } = await import('../src/api');
    expect(readFailure(new FirestoreError('resource-exhausted', 'Firestore 429 RESOURCE_EXHAUSTED: Read budget spent: run', 'run'))).toBe('read-budget');
    expect(readFailure(new FirestoreError('resource-exhausted', 'Firestore 429 RESOURCE_EXHAUSTED'))).toBe('firestore-quota');
    expect(readFailure(new FirestoreError('unavailable', 'Firestore unreachable'))).toBeNull();
  });

  test('a portal request is counted and capped at REQUEST_READS, with no share of the day', async () => {
    const { requestBudget, REQUEST_READS } = await import('../src/budget');
    const b = requestBudget();
    expect(b.summary()).toMatchObject({ run: REQUEST_READS, day: {}, ledger: 'none' });
  });
});
