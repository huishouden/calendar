import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { handleApi } from '../src/api';
import { syncPerson, runCron } from '../src/sync';
import { personId, loadPerson } from '../src/store';
import { eventId, instanceId } from '../src/google/events';
import { captureLogs } from '../src/log';
import { apiRequest, household, listDocs, readDoc, refreshFor, resetFirestore, seed, world, writeDoc, TZ, type World } from './helpers/world';

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

async function connect(email = 'alice@example.com'): Promise<{ pid: string; calendarId: string }> {
  const res = await call('/api/google/connect', email, { household, code: 'good-code', refreshToken: refreshFor(email), lang: 'en', timeZone: TZ });
  expect(res.status).toBe(200);
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
    await fetch(`http://127.0.0.1:8080/v1/projects/demo-huishouden-calendar/databases/(default)/documents/households/${household}/todos/${encodeURIComponent('tasks:item:paint')}`, { method: 'DELETE', headers: { Authorization: 'Bearer owner' } });
    await writeDoc(`households/${household}/agenda/home_job_filter`, { app: 'home', ref: 'job:filter', kind: 'due', title: 'Change the furnace filter', start: Date.parse('2031-10-15T00:00:00+02:00'), allDay: true, url: 'https://huishouden-piekstra.web.app/home/', status: 'upcoming', private: false, updatedAt: w.clock.now, by: 'bob@example.com' });
    const counts = await later(pid);
    expect([counts.inserted, counts.deleted]).toEqual([1, 1]);
    const live = w.google.live(calendarId).map((e) => e.summary);
    expect(live).toContain('Change the furnace filter');
    expect(live).not.toContain('To do: Buy paint');
    const job = w.google.live(calendarId).find((e) => e.summary === 'Change the furnace filter')!;
    expect(job.start).toEqual({ date: '2031-10-15' });
  });

  test('the cron syncs people in turn, counts only in its log', async () => {
    await connect('alice@example.com');
    await connect('bob@example.com');
    const logs = captureLogs();
    w.clock.now += 5 * MIN;
    const totals = await runCron(w.env, { fetch: w.fetch, now: w.clock.now });
    logs.restore();
    expect(totals.people).toBe(2);
    expect(logs.lines.join('\n')).not.toMatch(/example\.com|Checkup|Garbage|h1/);
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
