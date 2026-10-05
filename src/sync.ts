import type { ExportEvent } from '@huishouden/pwa-kit/calendar-export';
import type { Env, Fetch } from './env';
import type { BatchRequest, GoogleEvent } from './google/api';
import { eventId, googleBody, instanceId, overrideBody, regularBody } from './google/events';
import { snapshot } from './backsync';
import type { EventRow, PersonRow } from './store';

/**
 * Keeping a person's "Huishouden" Google calendar in step with what they see in the household,
 * both ways. Each round, for one person, in small units (src/round.ts):
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
/**
 * Google writes per unit: one batch request, small enough for the free plan's 10 ms of CPU per
 * invocation with the unit's other calls; the rest go in the next unit (src/round.ts).
 */
export const MAX_WRITES = 10;

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
  /** Writes Google refused as too many (429, or 403 rate limit): the work backs off. */
  limited: number;
  requests: number;
  full: boolean;
  /** Writes left for the next unit. */
  more: boolean;
}

export const zeroCounts = (): SyncCounts => ({ changes: 0, echoes: 0, applied: 0, refused: 0, conflicts: 0, hidden: 0, inserted: 0, updated: 0, deleted: 0, failed: 0, limited: 0, requests: 0, full: false, more: false });

interface Override {
  original: string;
  etag: string | null;
}

export const parseOverrides = (s: string | null): Override[] => {
  try {
    return s ? (JSON.parse(s) as Override[]) : [];
  } catch {
    return [];
  }
};

/** Whether a changed Google event is our own write coming back. */
export function isEcho(g: GoogleEvent, row: EventRow | undefined): boolean {
  if (!row || !g.etag) return false;
  if (row.etag === g.etag) return true;
  return parseOverrides(row.overrides).some((o) => o.etag === g.etag);
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
