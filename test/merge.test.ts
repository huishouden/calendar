import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { handleApi } from '../src/api';
import { syncPerson } from '../src/work';
import { personId, loadPerson } from '../src/store';
import { partition } from '../src/parts';
import { changeId, mergedEdits, type Edit } from '../src/backsync';
import type { ExportEvent } from '@huishouden/pwa-kit/calendar-export';
import type { AgendaItem } from '@huishouden/pwa-kit/agenda-core';
import { exportEvents, DEFAULT_CALENDAR_SETTINGS } from '@huishouden/pwa-kit/calendar-export';
import { toAgendaItem } from '@huishouden/pwa-kit/agenda-core';
import { apiRequest, drain, household, listDocs, readDoc, refreshFor, resetFirestore, seed, world, TZ, type World } from './helpers/world';
import fixture from './fixtures/household.json';

// Things that merge (@huishouden/pwa-kit/merge): garbage and recycling on the same mornings are one
// event in the person's Google calendar, and a change made to it there goes to both records.

let w: World;
const MIN = 60_000;
const call = (path: string, email: string, body?: Record<string, unknown>) => handleApi(w.env, apiRequest(path, email, body), undefined, { fetch: w.fetch, now: w.clock.now });

const MERGE = { garbage: { key: 'collection', part: 'garbage', title: '{parts} pickup' }, recycling: { key: 'collection', part: 'recycling', title: '{parts} pickup' } };
const DAYS = ['2031-10-02', '2031-10-09', '2031-10-16', '2031-10-23', '2031-10-30'];
const offset = (day: string) => (day < '2031-10-26' ? '+02:00' : '+01:00');

/** The fixture's garbage series marked to merge, and a recycling series on the same mornings (not skipped on the 16th, as garbage is). */
function mergingDocs(): Record<string, unknown> {
  const docs: Record<string, unknown> = {
    [`households/${household}/homeEvents/recycling`]: { title: 'Recycling pickup', kind: 'recycling', rule: fixture.series.rule, time: '07:00', createdAt: 1, by: 'alice@example.com' },
  };
  for (const [path, data] of Object.entries(fixture.docs)) {
    if (path.includes('/agenda/home_event_bins_')) docs[path] = { ...(data as object), merge: MERGE.garbage };
  }
  const recyclingEdit = JSON.parse(JSON.stringify(fixture.binsEdit).replaceAll('"bins"', '"recycling"'));
  for (const day of DAYS) {
    docs[`households/${household}/agenda/home_event_recycling_${day}`] = {
      app: 'home', ref: 'event:recycling', kind: 'other', title: 'Recycling pickup', start: `${day}T07:00:00${offset(day)}`, end: `${day}T07:30:00${offset(day)}`, allDay: false,
      detail: 'Every Thursday', url: 'https://huishouden-piekstra.web.app/home/#regular', private: false, series: `$series:${day}`, edit: recyclingEdit, merge: MERGE.recycling,
      updatedAt: '2031-09-30T12:00:00Z', by: 'alice@example.com',
    };
  }
  // Two visits booked the same day that merge: one event; deleting it in Google cancels each.
  for (const [id, part] of [['v1', 'plumber'], ['v2', 'electrician']] as const) {
    docs[`households/${household}/homeServiceLog/${id}`] = { date: '2031-10-08', title: `${part} visit`, createdAt: 1, by: 'alice@example.com' };
    docs[`households/${household}/agenda/home_visit_${id}`] = {
      app: 'home', ref: `visit:${id}`, kind: 'appointment', title: `${part} visit`, start: '2031-10-08T00:00:00+02:00', allDay: true, url: 'https://huishouden-piekstra.web.app/home/#history', private: false,
      merge: { key: 'visit', part, title: '{parts} visit' },
      edit: { cancel: { ops: [{ col: 'homeServiceLog', id, data: null }], roles: ['admin', 'member'] } },
      updatedAt: '2031-09-30T12:00:00Z', by: 'alice@example.com',
    };
  }
  return docs;
}

beforeAll(async () => {
  await resetFirestore();
});

beforeEach(async () => {
  await resetFirestore();
  await seed();
  await seed(mergingDocs());
  w = world();
});

async function connect(email = 'alice@example.com'): Promise<{ pid: string; calendarId: string }> {
  const res = await call('/api/google/connect', email, { household, code: 'good-code', refreshToken: refreshFor(email), lang: 'en', timeZone: TZ });
  expect(res.status).toBe(200);
  await drain(w);
  const pid = await personId(household, email);
  return { pid, calendarId: (await loadPerson(w.env, pid))!.google!.calendarId };
}

async function later(pid: string, minutes = 5) {
  w.clock.now += minutes * MIN;
  return syncPerson(w.env, pid, { fetch: w.fetch, now: w.clock.now });
}

const merged = (calendarId: string) => [...w.google.cal(calendarId).events.values()].find((e) => e.summary === 'Garbage and recycling pickup' && e.recurrence);

describe('merged events in Google Calendar', () => {
  test('one repeating event for both; the day garbage is skipped shows recycling alone', async () => {
    const { calendarId } = await connect();
    const events = [...w.google.cal(calendarId).events.values()].filter((e) => e.status !== 'cancelled');
    const master = merged(calendarId)!;
    expect(master).toBeDefined();
    expect(events.filter((e) => e.recurrence).map((e) => e.summary)).toEqual(['Garbage and recycling pickup']);
    expect(events.find((e) => e.recurringEventId === master.id && e.summary === 'Recycling pickup')).toBeDefined();
    expect(master.description).toContain('Garbage pickup: Every Thursday\nRecycling pickup: Every Thursday');
  });

  test('one occurrence deleted in Google: skipped in both records', async () => {
    const { pid, calendarId } = await connect();
    const master = merged(calendarId)!;
    w.clock.now += MIN;
    w.google.userInstance(calendarId, master.id!, '20311009T050000Z', { status: 'cancelled' });
    await later(pid);
    await later(pid);
    expect(((await readDoc(`households/${household}/homeEvents/bins`))!.exceptions as Record<string, unknown>)['2031-10-09']).toEqual({ skipped: true });
    expect(((await readDoc(`households/${household}/homeEvents/recycling`))!.exceptions as Record<string, unknown>)['2031-10-09']).toEqual({ skipped: true });
    const changes = await listDocs(`households/${household}/calendarChanges`);
    expect(changes.map((c) => c.data.ref).sort()).toEqual(['event:bins', 'event:recycling']);
  });

  test('a new title can\'t be said for two records: put back, nothing written', async () => {
    const { pid, calendarId } = await connect();
    const master = merged(calendarId)!;
    w.clock.now += MIN;
    w.google.userPatch(calendarId, master.id!, { summary: 'Bins' });
    await later(pid);
    expect((await readDoc(`households/${household}/homeEvents/bins`))!.title).toBe('Garbage pickup');
    expect((await readDoc(`households/${household}/homeEvents/recycling`))!.title).toBe('Recycling pickup');
    expect(w.google.cal(calendarId).events.get(master.id!)!.summary).toBe('Garbage and recycling pickup');
  });
});

describe('merged changes, record by record', () => {
  test('a merged one-off deleted in Google: each visit cancelled, only its own items gone, a history entry each', async () => {
    const { pid, calendarId } = await connect();
    const visit = [...w.google.cal(calendarId).events.values()].find((e) => e.summary === 'Electrician and plumber visit')!;
    expect(visit).toBeDefined();
    w.clock.now += MIN;
    w.google.userDelete(calendarId, visit.id!);
    await later(pid);
    await later(pid);
    expect(await readDoc(`households/${household}/homeServiceLog/v1`)).toBeNull();
    expect(await readDoc(`households/${household}/homeServiceLog/v2`)).toBeNull();
    const agenda = (await listDocs(`households/${household}/agenda`)).map((d) => d.data.ref);
    expect(agenda.filter((r) => String(r).startsWith('visit:'))).toEqual([]);
    expect(agenda.filter((r) => r === 'event:bins').length).toBeGreaterThan(0);
    const changes = await listDocs(`households/${household}/calendarChanges`);
    expect(changes.map((c) => [c.data.ref, c.data.change]).sort()).toEqual([['visit:v1', 'cancelled'], ['visit:v2', 'cancelled']]);
  });

  test('a helper deleting an occurrence of a merged series changes nothing they may not, and it is put back', async () => {
    const { pid, calendarId } = await connect('helen@example.com');
    const master = merged(calendarId)!;
    w.clock.now += MIN;
    w.google.userInstance(calendarId, master.id!, '20311009T050000Z', { status: 'cancelled' });
    const counts = await later(pid);
    await later(pid);
    expect(counts.refused).toBeGreaterThan(0);
    for (const id of ['bins', 'recycling']) expect(((await readDoc(`households/${household}/homeEvents/${id}`))!.exceptions as Record<string, unknown> | undefined)?.['2031-10-09']).toBeUndefined();
    expect(await listDocs(`households/${household}/calendarChanges`)).toEqual([]);
  });
});

describe('mergedEdits', () => {
  const item = (ref: string, original?: string, id = `${ref}-${original ?? 'x'}`) =>
    toAgendaItem(id, { app: 'home', ref, kind: 'other', title: ref, start: 1, allDay: true, url: 'https://example.com/', ...(original ? { series: { rule: { freq: 'week', every: 1, start: '2031-09-04' }, original, through: '2031-10-30' } } : {}) });
  const event = (items: AgendaItem[]) => ({ key: 'merge|x', merged: true, items }) as unknown as ExportEvent;
  const edit = (kind: Edit['kind'], original?: string): Edit => ({ kind, event: event([]), item: item('x'), values: original ? { original } : {}, at: 1 });
  const refs = (r: ReturnType<typeof mergedEdits>) => ('edits' in r ? r.edits.map((e) => e.item.id) : r);

  test('one edit per record: on the day, the records that have it; past the published days, every record', () => {
    const e = event([item('event:a', '2031-10-02'), item('event:a', '2031-10-09'), item('event:b', '2031-10-02')]);
    expect(refs(mergedEdits([edit('skip', '2031-10-02')], e))).toEqual(['event:a-2031-10-02', 'event:b-2031-10-02']);
    expect(refs(mergedEdits([edit('skip', '2031-10-09')], e))).toEqual(['event:a-2031-10-09']);
    expect(refs(mergedEdits([edit('reschedule', '2031-12-04')], e))).toEqual(['event:a-2031-10-02', 'event:b-2031-10-02']);
  });

  test('a one-off: once per record, however many items it has', () => {
    const e = event([item('visit:a', undefined, 'a1'), item('visit:a', undefined, 'a2'), item('visit:b', undefined, 'b1')]);
    expect(refs(mergedEdits([edit('cancel')], e))).toEqual(['a1', 'b1']);
  });

  test('a title, notes or a new series time is put back; hiding passes; nothing to act through is put back', () => {
    const e = event([item('visit:a'), item('visit:b')]);
    for (const kind of ['rename', 'notes', 'retime'] as const) expect(mergedEdits([edit(kind)], e)).toEqual({ revert: true });
    expect(refs(mergedEdits([edit('hide')], e))).toEqual(['x-x']);
    expect(mergedEdits([edit('cancel')], event([]))).toEqual({ revert: true });
  });

  test('a retried change has the same history id for each record, whichever item it goes through', () => {
    expect(changeId('g1', 5, 'skip', 'home|event:a|2031-10-02')).toBe(changeId('g1', 5, 'skip', 'home|event:a|2031-10-02'));
    expect(changeId('g1', 5, 'skip', 'home|event:a|2031-10-02')).not.toBe(changeId('g1', 5, 'skip', 'home|event:b|2031-10-02'));
  });
});

describe('exporting in parts', () => {
  test('records that merge stay in one part, so the parts export as the whole does', async () => {
    const agenda = (await listDocs(`households/${household}/agenda`)).map((d) => toAgendaItem(d.id, d.data));
    const input = { me: 'alice@example.com', role: 'admin' as const, settings: DEFAULT_CALENDAR_SETTINGS };
    const parts = partition({ agenda, todos: [] }, input, 2);
    expect(parts.length).toBeGreaterThan(1);
    const whole = exportEvents({ ...input, agenda, todos: [], lang: 'en', timeZone: TZ }).map((e) => e.key).sort();
    const pieced = parts.flatMap((p) => exportEvents({ ...input, agenda: p.agenda, todos: [], lang: 'en', timeZone: TZ })).map((e) => e.key).sort();
    expect(pieced).toEqual(whole);
  });

  test('a helper\'s parts hold nothing private', async () => {
    const agenda = (await listDocs(`households/${household}/agenda`)).map((d) => toAgendaItem(d.id, d.data));
    expect(agenda.some((i) => i.private === true)).toBe(true);
    const parts = partition({ agenda, todos: [] }, { me: 'helen@example.com', role: 'helper', settings: DEFAULT_CALENDAR_SETTINGS }, 2);
    expect(parts.flatMap((p) => p.agenda).some((i) => i.private !== false)).toBe(false);
  });
});
