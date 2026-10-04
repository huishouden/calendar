import { exportEvents, loadExportLang, type ExportEvent } from '@huishouden/pwa-kit/calendar-export';
import type { AgendaItem } from '@huishouden/pwa-kit/agenda-core';
import { LocalClock } from '@huishouden/pwa-kit/local-clock';
import type { Env, Fetch } from './env';
import { log } from './log';
import { NotMember, Person, signInGone, type Loaded, type View } from './person';
import { accessToken, GoogleAuthError } from './google/oauth';
import { Calendar, CalendarApiError, SyncTokenGone, type BatchRequest, type GoogleEvent } from './google/api';
import { eventId, googleBody, instanceId, overrideBody, regularBody } from './google/events';
import { applyEdit, dateFormatter, readChange, snapshot, type Edit, type Written } from './backsync';
import { deleteEventRow, eventRows, loadPerson, personRow, putEventRow, savePerson, upsertPersonRow, type EventRow, type PersonRecord } from './store';

/**
 * Keeping a person's "Huishouden" Google calendar in step with what they see in the household,
 * both ways. Each run, for one person:
 *
 * 1. Ask Google what changed in the calendar since the last run (`events.list` with the sync token).
 *    A change whose etag is the one our own write got back is an echo and is dropped.
 * 2. Check the person's change signal (src/person.ts). Nothing changed on either side: done, at the
 *    cost of a handful of small requests.
 * 3. Otherwise read their agenda, carry Google's changes back to the records (src/backsync.ts),
 *    and work out the calendar they should see (`@huishouden/pwa-kit/calendar-export`).
 * 4. Write the difference to Google in batches: new events (with ids made from the key, so a retry
 *    can't duplicate), changed ones (by the export's hash), moved occurrences, deleted ones.
 *
 * A full rebuild happens at least every 6 hours anyway, in case a change slipped past the signal.
 */

export const FULL_EVERY_MS = 6 * 3_600_000;
/** Writes per person per run; the rest go next run. */
export const MAX_WRITES = 200;

export interface SyncCounts {
  changes: number;
  echoes: number;
  applied: number;
  refused: number;
  conflicts: number;
  hidden: number;
  inserted: number;
  updated: number;
  deleted: number;
  failed: number;
  requests: number;
  full: boolean;
}

const zero = (): SyncCounts => ({ changes: 0, echoes: 0, applied: 0, refused: 0, conflicts: 0, hidden: 0, inserted: 0, updated: 0, deleted: 0, failed: 0, requests: 0, full: false });

export interface SyncDeps {
  fetch?: Fetch;
  now?: number;
  /** Firestore's REST base (tests: the emulator). */
  firestoreUrl?: string;
}

interface Override {
  original: string;
  etag: string | null;
}

const parseOverrides = (s: string | null): Override[] => {
  try {
    return s ? (JSON.parse(s) as Override[]) : [];
  } catch {
    return [];
  }
};

/** Whether a changed Google event is our own write coming back. */
function isEcho(g: GoogleEvent, row: EventRow | undefined): boolean {
  if (!row || !g.etag) return false;
  if (row.etag === g.etag) return true;
  return parseOverrides(row.overrides).some((o) => o.etag === g.etag);
}

/** One person's sync. Throws only for what the caller should record as the run's error. */
export async function syncPerson(env: Env, pid: string, deps: SyncDeps = {}): Promise<SyncCounts> {
  const now = deps.now ?? Date.now();
  const fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
  const counts = zero();
  const record = await loadPerson(env, pid);
  const row = await personRow(env, pid);
  if (!record?.google || !row) {
    await upsertPersonRow(env, pid, { google: 0 }, now);
    return counts;
  }
  const google = record.google;
  const tz = record.timeZone;
  let calendar: Calendar;
  try {
    calendar = new Calendar(await accessToken(env, google.refreshToken, fetchImpl, now), fetchImpl);
  } catch (e) {
    if (e instanceof GoogleAuthError && e.kind === 'revoked') {
      await upsertPersonRow(env, pid, { last_sync: now, last_error: 'google-revoked' }, now);
      return counts;
    }
    throw e;
  }

  // 1. What changed in Google.
  let changed: GoogleEvent[] = [];
  let nextSyncToken: string | undefined;
  let syncToken = row.sync_token;
  try {
    const answer = await calendar.changes(google.calendarId, syncToken);
    changed = answer.items;
    nextSyncToken = answer.nextSyncToken;
  } catch (e) {
    if (e instanceof SyncTokenGone) {
      syncToken = null;
      const answer = await calendar.changes(google.calendarId, null);
      changed = answer.items;
      nextSyncToken = answer.nextSyncToken;
    } else if (e instanceof CalendarApiError && e.status === 404) {
      // They deleted the Huishouden calendar in Google: stop syncing until they connect again.
      await savePerson(env, pid, { ...record, google: undefined });
      await upsertPersonRow(env, pid, { google: 0, last_sync: now, last_error: 'calendar-deleted', sync_token: null }, now);
      await env.DB.prepare('DELETE FROM events WHERE pid = ?').bind(pid).run();
      return counts;
    } else throw e;
  }
  const rows = await eventRows(env, pid);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const byId = new Map(rows.map((r) => [r.event_id, r]));
  // A first full listing (no sync token) is our own events as they are, not changes.
  const real = syncToken ? changed.filter((g) => !isEcho(g, byId.get(g.recurringEventId ?? g.id))) : [];
  counts.changes = changed.length;
  counts.echoes = changed.length - real.length;

  // 2. What changed in the household.
  const person = new Person(env, record, fetchImpl, deps.firestoreUrl);
  let view: View;
  try {
    view = await person.view();
  } catch (e) {
    if (e instanceof NotMember) {
      await upsertPersonRow(env, pid, { last_sync: now, last_error: 'not-member' }, now);
      return counts;
    }
    if (signInGone(e)) {
      await savePerson(env, pid, { ...record, signedOut: true });
      await upsertPersonRow(env, pid, { last_sync: now, last_error: 'signed-out' }, now);
      return counts;
    }
    throw e;
  }
  const signal = await person.signal(view, `${record.lang}|${tz}`);
  const full = !row.full_at || now - row.full_at > FULL_EVERY_MS || rows.length === 0;
  if (signal === row.signal && real.length === 0 && !full) {
    await upsertPersonRow(env, pid, { last_sync: now, last_ok: now, last_error: null, ...(nextSyncToken && nextSyncToken !== row.sync_token && changed.length > 0 ? { sync_token: nextSyncToken } : {}) }, now);
    counts.requests = calendar.requests;
    return counts;
  }
  counts.full = true;
  await loadExportLang(record.lang);
  let loaded = await person.load(view);
  let events = exportFor(loaded, view, record);

  // 3. Google's changes, carried back.
  const forced = new Set<string>();
  const hide = new Set<string>();
  if (real.length) {
    const format = dateFormatter(record.lang, tz);
    const clock = new LocalClock(tz, () => now);
    const writtenOf = (r: EventRow): Written | undefined => {
      try {
        return r.written ? (JSON.parse(r.written) as Written) : undefined;
      } catch {
        return undefined;
      }
    };
    for (const g of real) {
      const r = byId.get(g.recurringEventId ?? g.id);
      if (!r) continue;
      const reading = readChange(g, writtenOf(r), events.find((e) => e.key === r.key), tz, format);
      if ('ignore' in reading) continue;
      if ('revert' in reading) {
        forced.add(r.key);
        continue;
      }
      for (const found of reading.edits as Edit[]) {
        if (found.kind === 'hide') {
          hide.add(r.key);
          counts.hidden++;
          continue;
        }
        // Each edit acts on the records as they are now: an earlier one may have just changed them.
        const items = loaded.agenda.filter((i: AgendaItem) => i.app === found.item.app && i.ref === found.item.ref);
        const fresh = items.find((i) => i.id === found.item.id) ?? items.find((i) => i.series && i.series.original === found.item.series?.original) ?? items[0];
        if (!fresh) continue;
        const edit = { ...found, item: fresh, gid: g.id };
        const outcome = await applyEdit(edit, { person, view, today: clock.today(), now, timeZone: tz, items });
        if (outcome === 'applied' || outcome === 'already') {
          counts.applied++;
          loaded = await person.load(view);
        } else if (outcome === 'conflict') {
          counts.conflicts++;
          forced.add(r.key);
        } else {
          counts.refused++;
          // Something they may not change (or that is gone): out of their calendar if they deleted
          // it, put back as it is otherwise.
          if (g.status === 'cancelled' && !g.recurringEventId) hide.add(r.key);
          else forced.add(r.key);
        }
      }
    }
    if (counts.applied) events = exportFor(loaded, view, record);
  }

  // 4. The difference, written to Google.
  const plan = await planWrites(pid, events, rows, { householdId: record.household, timeZone: tz, calendarId: google.calendarId, forced, hide });
  const responses = await calendar.batch(plan.requests.slice(0, MAX_WRITES).map((p) => p.request));
  const retry: BatchRequest[] = [];
  const retryOf: number[] = [];
  responses.forEach((res, i) => {
    const p = plan.requests[i];
    // Inserting an id Google has seen before (deleted, or written by a run that didn't finish): update it instead.
    if (p.kind === 'insert' && res.status === 409) {
      retry.push({ method: 'PUT', path: `/calendars/${encodeURIComponent(google.calendarId)}/events/${p.eventId}`, body: p.request.body });
      retryOf.push(i);
    }
  });
  const retried = await calendar.batch(retry);
  retried.forEach((res, j) => (responses[retryOf[j]] = res));
  const statements: D1PreparedStatement[] = [];
  const etags = new Map<string, string | null>();
  responses.forEach((res, i) => {
    const p = plan.requests[i];
    const ok = res.status >= 200 && res.status < 300;
    const gone = p.kind === 'delete' && (res.status === 404 || res.status === 410);
    if (!ok && !gone) {
      counts.failed++;
      return;
    }
    if (p.kind === 'insert') counts.inserted++;
    else if (p.kind === 'update') counts.updated++;
    else if (p.kind === 'delete') counts.deleted++;
    etags.set(`${p.key}|${p.original ?? ''}`, typeof res.body?.etag === 'string' ? (res.body.etag as string) : null);
  });
  const doneKeys = new Set(plan.requests.slice(0, MAX_WRITES).map((p) => p.key));
  const failedKeys = new Set(plan.requests.slice(0, MAX_WRITES).filter((_, i) => !(responses[i].status < 300 || (plan.requests[i].kind === 'delete' && [404, 410].includes(responses[i].status)))).map((p) => p.key));
  for (const next of plan.rows) {
    if (!doneKeys.has(next.key) && !hide.has(next.key)) continue;
    if (failedKeys.has(next.key)) continue;
    if (next.deleted) {
      statements.push(deleteEventRow(env, pid, next.key));
      continue;
    }
    const master = etags.get(`${next.key}|`);
    const overrides = next.overrides.map((o) => ({ original: o, etag: etags.get(`${next.key}|${o}`) ?? parseOverrides(byKey.get(next.key)?.overrides ?? null).find((x) => x.original === o)?.etag ?? null }));
    statements.push(
      putEventRow(env, {
        pid,
        key: next.key,
        event_id: next.eventId,
        hash: next.hash,
        etag: master !== undefined ? master : (byKey.get(next.key)?.etag ?? null),
        overrides: JSON.stringify(overrides),
        written: next.written,
        hidden: next.hidden ? 1 : 0,
      }),
    );
  }
  if (statements.length) await env.DB.batch(statements);
  counts.requests = calendar.requests;
  const finished = plan.requests.length <= MAX_WRITES && counts.failed === 0;
  await upsertPersonRow(
    env,
    pid,
    {
      last_sync: now,
      ...(counts.failed === 0 ? { last_ok: now, last_error: null } : { last_error: 'google-write' }),
      signal: finished ? signal : null,
      full_at: finished ? now : row.full_at,
      ...(nextSyncToken ? { sync_token: nextSyncToken } : {}),
      notice: counts.refused ? `refused:${counts.refused}` : row.notice,
      counts: JSON.stringify({ applied: counts.applied, refused: counts.refused, inserted: counts.inserted, updated: counts.updated, deleted: counts.deleted, events: events.length }),
    },
    now,
  );
  return counts;
}

function exportFor(loaded: Loaded, view: View, record: PersonRecord): ExportEvent[] {
  return exportEvents({ ...loaded, me: record.email, role: view.role, lang: record.lang, timeZone: record.timeZone, settings: view.settings });
}

export interface PlannedRequest {
  kind: 'insert' | 'update' | 'patch' | 'delete';
  key: string;
  eventId: string;
  /** An occurrence's original day, for an instance write. */
  original?: string;
  request: BatchRequest;
}

export interface PlannedRow {
  key: string;
  eventId: string;
  hash: string;
  /** What is written for it (JSON of `snapshot`), kept for reading changes made in Google. */
  written: string | null;
  overrides: string[];
  hidden: boolean;
  deleted: boolean;
}

/** The writes that make the calendar match `events`, and the rows to keep afterwards. Pure but for the ids. */
export async function planWrites(
  pid: string,
  events: ExportEvent[],
  rows: EventRow[],
  { householdId, timeZone, calendarId, forced = new Set(), hide = new Set() }: { householdId: string; timeZone: string; calendarId: string; forced?: Set<string>; hide?: Set<string> },
): Promise<{ requests: PlannedRequest[]; rows: PlannedRow[] }> {
  const cal = `/calendars/${encodeURIComponent(calendarId)}/events`;
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const requests: PlannedRequest[] = [];
  const next: PlannedRow[] = [];
  const wanted = new Set(events.map((e) => e.key));
  for (const e of events) {
    const row = byKey.get(e.key);
    const id = row?.event_id ?? (await eventId(pid, e.key));
    const hash = `${e.hash}|${timeZone}`;
    const overrides = e.series?.overrides.map((o) => o.original!) ?? [];
    if (row?.hidden || hide.has(e.key)) {
      next.push({ key: e.key, eventId: id, hash: row?.hash ?? hash, written: row?.written ?? null, overrides: [], hidden: true, deleted: false });
      continue;
    }
    if (row && row.hash === hash && !forced.has(e.key)) continue;
    const body = googleBody(e, { id, householdId, timeZone });
    if (!row) requests.push({ kind: 'insert', key: e.key, eventId: id, request: { method: 'POST', path: cal, body } });
    else requests.push({ kind: 'update', key: e.key, eventId: id, request: { method: 'PUT', path: `${cal}/${id}`, body } });
    if (e.series) {
      for (const o of e.series.overrides) {
        requests.push({ kind: 'patch', key: e.key, eventId: id, original: o.original, request: { method: 'PATCH', path: `${cal}/${instanceId(id, e.series, o.original!, timeZone)}`, body: overrideBody(o, timeZone) } });
      }
      // Occurrences moved before and back on their own day now.
      const before = parseOverrides(row?.overrides ?? null).map((o) => o.original);
      for (const original of before.filter((o) => !overrides.includes(o) && !e.series!.exdates.includes(o))) {
        requests.push({ kind: 'patch', key: e.key, eventId: id, original, request: { method: 'PATCH', path: `${cal}/${instanceId(id, e.series, original, timeZone)}`, body: regularBody(e, original, timeZone) } });
      }
    }
    next.push({ key: e.key, eventId: id, hash, written: JSON.stringify(snapshot(e)), overrides, hidden: false, deleted: false });
  }
  for (const row of rows) {
    if (wanted.has(row.key)) continue;
    if (!row.hidden) requests.push({ kind: 'delete', key: row.key, eventId: row.event_id, request: { method: 'DELETE', path: `${cal}/${row.event_id}` } });
    next.push({ key: row.key, eventId: row.event_id, hash: row.hash, written: null, overrides: [], hidden: !!row.hidden, deleted: true });
  }
  // Deletions first, so a full calendar never briefly holds an item twice.
  requests.sort((a, b) => Number(b.kind === 'delete') - Number(a.kind === 'delete'));
  return { requests, rows: next };
}

/** Per run: subrequests the cron keeps for each person (a token, the change list, the checks, batches). */
export const PER_PERSON_BUDGET = 12;

/** The cron: as many people as the run's budget allows, the longest unsynced first. */
export async function runCron(env: Env, deps: SyncDeps & { budget?: number } = {}): Promise<Record<string, number>> {
  const budget = deps.budget ?? 45;
  const people = await env.DB.prepare('SELECT pid FROM people WHERE google = 1 ORDER BY COALESCE(last_sync, 0) ASC LIMIT ?').bind(Math.max(1, Math.floor(budget / PER_PERSON_BUDGET))).all<{ pid: string }>();
  const totals: Record<string, number> = { people: 0, failed: 0 };
  let used = 0;
  for (const { pid } of people.results) {
    if (used + PER_PERSON_BUDGET > budget) break;
    try {
      const c = await syncPerson(env, pid, deps);
      totals.people++;
      used += Math.max(c.requests + 8, 4);
      for (const [k, v] of Object.entries(c)) if (typeof v === 'number') totals[k] = (totals[k] ?? 0) + v;
    } catch (e) {
      totals.failed++;
      used += PER_PERSON_BUDGET;
      const reason = e instanceof CalendarApiError ? `google-${e.status}` : e instanceof GoogleAuthError ? `google-${e.kind}` : 'error';
      await upsertPersonRow(env, pid, { last_sync: deps.now ?? Date.now(), last_error: reason }, deps.now ?? Date.now());
    }
  }
  log('sync-run', totals);
  return totals;
}
