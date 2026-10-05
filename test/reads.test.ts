import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { handleApi } from '../src/api';
import { checkPeople, dueAnyway, householdDue, ACTIVE_MS, QUIET_EVERY_MIN } from '../src/check';
import { FULL_EVERY_MS } from '../src/sync';
import { FEED, SYNC } from '../src/work';
import { Person } from '../src/person';
import { LIST_MAX_AGE_MS } from '../src/lists';
import { loadPerson, personId } from '../src/store';
import { apiRequest, deleteDoc, drain, household, readDoc, refreshFor, resetFirestore, seed, world, writeDoc, TZ, type World } from './helpers/world';

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
const person = (email: string) => new Person(w.env, { household, email, refreshToken: refreshFor(email) }, w.fetch);
/** Loads as `email` and says how each list was read. */
async function load(email: string, now = w.clock.now) {
  const p = person(email);
  const view = await p.view();
  const loaded = await p.load(view, now);
  return { loaded, how: loaded.reads as Record<string, string>, p, view };
}
const agendaPath = `households/${household}/agenda/baby_appointment_a1`;

describe('lists kept between loads', () => {
  test('unchanged: the kept copy, the same as reading everything', async () => {
    const first = await load('alice@example.com');
    expect(first.how.agenda).toBe('full');
    const again = await load('alice@example.com');
    expect(again.how).toEqual(Object.fromEntries(Object.keys(first.how).map((k) => [k, 'kept'])));
    expect({ ...again.loaded, reads: {} }).toEqual({ ...first.loaded, reads: {} });
    // The signal from a kept load is still the aggregations' own.
    expect(again.p.signalOf(again.view, again.loaded, 'x')).toBe(await again.p.signal(again.view, 'x'));
  });

  test('an item changed or added: only what changed is read, merged in', async () => {
    await load('alice@example.com');
    await writeDoc(agendaPath, { ...(await readDoc(agendaPath))!, title: 'Checkup at 18 months', updatedAt: w.clock.now + MIN });
    const { how, loaded } = await load('alice@example.com');
    expect(how.agenda).toBe('delta');
    expect(loaded.agenda.find((i) => i.id === 'baby_appointment_a1')!.title).toBe('Checkup at 18 months');
    const fresh = await (async () => {
      await w.env.DB.prepare('DELETE FROM lists').run();
      return (await load('alice@example.com')).loaded;
    })();
    expect(loaded.agenda.map((i) => i.id).sort()).toEqual(fresh.agenda.map((i) => i.id).sort());
    expect(loaded.tally).toEqual(fresh.tally);
  });

  test('an item deleted: the merged copy can’t match the count, so the whole list is read', async () => {
    await load('alice@example.com');
    await deleteDoc(agendaPath);
    const { how, loaded } = await load('alice@example.com');
    expect(how.agenda).toBe('full');
    expect(loaded.agenda.some((i) => i.id === 'baby_appointment_a1')).toBe(false);
  });

  test('members share a copy only with members who may read the same: a helper’s is its own', async () => {
    await load('alice@example.com');
    expect((await load('bob@example.com')).how.agenda).toBe('kept');
    const helper = await load('helen@example.com');
    expect(helper.how.agenda).toBe('full');
    // The helper never gets the private bill the admin's copy has.
    expect(helper.loaded.agenda.some((i) => i.app === 'bills')).toBe(false);
    expect((await load('alice@example.com')).loaded.agenda.some((i) => i.app === 'bills')).toBe(true);
    // A helper's list is filtered: a change reads it whole.
    await writeDoc(agendaPath, { ...(await readDoc(agendaPath))!, title: 'Checkup moved', updatedAt: w.clock.now + MIN });
    expect((await load('helen@example.com')).how.agenda).toBe('full');
    expect((await load('alice@example.com')).how.agenda).toBe('delta');
  });

  test('a kid shares the helper’s copy (the same query), never a member’s private items', async () => {
    await load('alice@example.com');
    await load('helen@example.com');
    const kid = await load('kim@example.com');
    expect(kid.how.agenda).toBe('kept');
    expect(kid.loaded.agenda.some((i) => i.app === 'bills' || i.private)).toBe(false);
  });

  test('a personal list is each member’s own: taken off an item’s audience, it is gone at the next load', async () => {
    const path = `households/${household}/personalAgenda/health_dose`;
    const before = await readDoc(path);
    expect(before).not.toBeNull();
    const audience = before!.audience as string[];
    const carer = audience[0];
    const first = await load(carer);
    expect(first.loaded.agenda.some((i) => i.id === 'health_dose')).toBe(true);
    // Someone not named never gets it, kept or not.
    const other = ['alice@example.com', 'bob@example.com', 'cora@example.com'].find((e) => !audience.includes(e))!;
    expect((await load(other)).loaded.agenda.some((i) => i.id === 'health_dose')).toBe(false);
    await writeDoc(path, { ...before!, audience: audience.filter((e) => e !== carer).length ? audience.filter((e) => e !== carer) : ['nobody@example.com'], updatedAt: w.clock.now + MIN });
    const after = await load(carer);
    expect(after.how.personalAgenda).toBe('full');
    expect(after.loaded.agenda.some((i) => i.id === 'health_dose')).toBe(false);
  });

  test('a copy a day old is read whole again', async () => {
    await load('alice@example.com');
    expect((await load('alice@example.com', w.clock.now + LIST_MAX_AGE_MS - MIN)).how.agenda).toBe('kept');
    expect((await load('alice@example.com', w.clock.now + LIST_MAX_AGE_MS)).how.agenda).toBe('full');
  });

  test('nothing readable in D1: copies are sealed, keys are hashes', async () => {
    await load('alice@example.com');
    const { results } = await w.env.DB.prepare('SELECT key, body FROM lists').all<{ key: string; body: string }>();
    expect(results.length).toBeGreaterThan(0);
    expect(JSON.stringify(results)).not.toMatch(/Checkup|example\.com|households|Garbage/);
  });
});

describe('a quiet household is read every 15 minutes', () => {
  test('householdDue: the first check of each quarter hour of the slot, every check while active', () => {
    const row = { shard: 7, hh_signal: 's', hh_signal_at: 0 };
    const base = Date.parse('2031-10-01T12:00:00Z') + 7 * MIN + 3_000;
    const due = Array.from({ length: 12 }, (_, k) => householdDue(row, base + k * 5 * MIN, 5));
    expect(due.filter(Boolean).length).toBe(4);
    for (let k = 0; k < 12; k += 3) expect(due.slice(k, k + 3).filter(Boolean).length).toBe(1);
    // Active: every check.
    expect(Array.from({ length: 12 }, (_, k) => householdDue({ ...row, hh_signal_at: base }, base + k * 5 * MIN, 5)).every(Boolean)).toBe(true);
    // An hour after the last change it is quiet again.
    expect(householdDue({ ...row, hh_signal_at: base }, base + ACTIVE_MS + 5 * MIN, 5)).toBe(householdDue(row, base + ACTIVE_MS + 5 * MIN, 5));
    // Never seen, checks 15 minutes apart, or not the cron's: every check.
    expect(householdDue({ ...row, hh_signal: null }, base + 5 * MIN, 5)).toBe(true);
    expect(householdDue(row, base + 5 * MIN, QUIET_EVERY_MIN)).toBe(true);
    expect(householdDue(row, base + 5 * MIN, undefined)).toBe(true);
  });

  test('a quiet check still marks what is due anyway: a sync not rebuilt in 6 hours, a stale feed', () => {
    const now = Date.parse('2031-10-01T12:00:00Z');
    const fresh = { full_at: now - MIN, feed: 1, feed_stale: 0 };
    expect(dueAnyway(fresh, { feed: { secret: 's', createdAt: 0 } }, now, true)).toBe(0);
    expect(dueAnyway({ ...fresh, full_at: now - FULL_EVERY_MS - MIN }, {}, now, true)).toBe(SYNC);
    expect(dueAnyway({ ...fresh, full_at: null }, {}, now, false)).toBe(0);
    expect(dueAnyway({ ...fresh, feed_stale: 1 }, { feed: { secret: 's', createdAt: 0 } }, now, true)).toBe(FEED);
  });

  test('the cron’s checks: Google every time, Firestore once in 15 minutes while quiet, and a change still arrives', async () => {
    const email = 'alice@example.com';
    const res = await handleApi(w.env, apiRequest('/api/google/connect', email, { household, code: 'good-code', refreshToken: refreshFor(email), lang: 'en', timeZone: TZ }), undefined, { fetch: w.fetch, now: w.clock.now });
    expect(res.status).toBe(200);
    await drain(w);
    const pid = await personId(household, email);
    const calendarId = (await loadPerson(w.env, pid))!.google!.calendarId;
    let firestore = 0;
    const counting = (url: string, init?: RequestInit) => {
      if (url.includes('/v1/projects/')) firestore++;
      return w.fetch(url, init);
    };
    const check = async () => {
      firestore = 0;
      const t = await checkPeople(w.env, [pid], { fetch: counting, now: w.clock.now, googleEvery: 5 });
      await drain(w);
      return { firestore, quiet: t.quiet };
    };
    // Settle: echoes of the first sync, the first signal seen, an hour of nothing.
    await check();
    w.clock.now += ACTIVE_MS + MIN;
    await check();
    const quarter: { firestore: number; quiet: number }[] = [];
    for (let k = 0; k < 3; k++) {
      w.clock.now += 5 * MIN;
      quarter.push(await check());
    }
    expect(quarter.filter((c) => c.firestore > 0).length).toBe(1);
    expect(quarter.filter((c) => c.quiet === 1).length).toBe(2);
    // A change: seen within 15 minutes, then every check for the hour after.
    await writeDoc(agendaPath, { ...(await readDoc(agendaPath))!, title: 'Checkup at 18 months', updatedAt: w.clock.now });
    let seenAfter = 0;
    for (let k = 1; k <= 3 && !seenAfter; k++) {
      w.clock.now += 5 * MIN;
      await check();
      if (w.google.live(calendarId).some((e) => e.summary === 'Checkup at 18 months')) seenAfter = k;
    }
    expect(seenAfter).toBeGreaterThan(0);
    w.clock.now += 5 * MIN;
    expect((await check()).quiet).toBe(0);
  });
});
