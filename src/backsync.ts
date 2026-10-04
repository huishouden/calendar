import {
  DELETE_FIELD, agendaId, canEdit, fillEditOps, type AgendaEditKind, type AgendaItem, type EditValues,
} from '@huishouden/pwa-kit/agenda-core';
import { resolveOps } from '@huishouden/pwa-kit/todo-core';
import { inverseOps, type Op } from '@huishouden/pwa-kit/store';
import { contentHash, recurrenceIdOf, type ExportEvent, type ExportSeries } from '@huishouden/pwa-kit/calendar-export';
import { allDayOf, clockIn, dayIn, zonedTime } from '@huishouden/pwa-kit/ics';
import { FieldDelete, FirestoreError, type Write } from '@huishouden/pwa-kit/firestore-rest';
import { DEFAULT_LOCALES, type Lang } from '@huishouden/pwa-kit/i18n';
import type { Ymd } from '@huishouden/pwa-kit/time';
import type { GoogleDateTime, GoogleEvent } from './google/api';
import type { Person, View } from './person';

/**
 * Changes made in Google Calendar, carried back to the record they came from.
 *
 * Each published agenda item carries declarative edits (`edit` in `@huishouden/pwa-kit/agenda-core`):
 * the writes on the app's own collections that move, rename, re-note, skip or cancel it. A change in
 * Google becomes one of those, filled in with the new values and written as the person, so the
 * app's rules decide whether they may. The agenda item moves with it (so the calendar doesn't flip
 * back before anyone opens the app), and the change goes in the person's history
 * (`calendarChanges`) with the writes that undo it.
 *
 * - Moving an event (or one occurrence of a series) to another day or time: `reschedule`.
 * - Changing the time of every occurrence of a series: `retime`.
 * - A new title: `rename` (for a series, the whole series'). New notes: `notes`.
 * - Deleting one occurrence of a series: `skip`. Deleting a one-off: `cancel`.
 * - Deleting a whole series, or anything the person may not change, only takes it out of their own
 *   calendar (`hide`): the household's record stays as it is.
 *
 * Anything else (a series' days changed, a title changed on one occurrence) can't be said in the
 * app's terms, so the next push puts the event back as the app has it (`revert`).
 *
 * Conflicts: last writer wins by time. When the agenda item was updated after Google's change
 * (`updatedAt` against the event's `updated`), the app's version stands and is pushed again.
 */

export type EditKind = AgendaEditKind | 'hide';

export interface Edit {
  kind: EditKind;
  /** The export event the change is to. */
  event: ExportEvent;
  /** The agenda item it acts through (an occurrence's own when it has one). */
  item: AgendaItem;
  values: EditValues;
  /** When Google says the change was made (ms). */
  at: number;
  /** For the history, in the person's words. */
  from?: string;
  to?: string;
}

export type Reading = { edits: Edit[] } | { revert: true } | { ignore: true };

/** What the sync last wrote for an export event: what a change in Google is measured against. */
export type Written = Omit<ExportEvent, 'items' | 'todo' | 'hash' | 'updatedAt' | 'series'> & {
  series?: Omit<ExportSeries, 'overrides'> & { overrides: Omit<ExportEvent, 'items' | 'todo' | 'hash' | 'updatedAt' | 'series'>[] };
};

const bare = ({ items: _i, todo: _t, hash: _h, updatedAt: _u, series: _s, ...rest }: ExportEvent) => rest;

/** The snapshot kept with each event row (no agenda items, no hashes). */
export function snapshot(e: ExportEvent): Written {
  return { ...bare(e), ...(e.series ? { series: { ...e.series, overrides: e.series.overrides.map(bare) } } : {}) };
}

/** The absolute start of a Google date or dateTime, in `timeZone` for a date. */
function startOf(dt: GoogleDateTime | undefined, timeZone: string): { at: number; allDay: boolean; date: Ymd } | null {
  if (!dt) return null;
  if (dt.date) return { at: zonedTime(dt.date, undefined, timeZone), allDay: true, date: dt.date };
  if (dt.dateTime) {
    // Google writes an offset; a time without one is the wall clock in the event's own zone.
    const wall = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2}(\.\d+)?)?$/.exec(dt.dateTime);
    const at = wall ? zonedTime(wall[1], wall[2], dt.timeZone ?? timeZone) : Date.parse(dt.dateTime);
    return Number.isNaN(at) ? null : { at, allDay: false, date: dayIn(at, timeZone) };
  }
  return null;
}

/** The new values of a move, as the edit placeholders want them. */
function moveValues(g: GoogleEvent, timeZone: string): EditValues | null {
  const start = startOf(g.start, timeZone);
  const end = startOf(g.end, timeZone);
  if (!start) return null;
  return {
    start: start.at,
    ...(end ? { end: end.at } : {}),
    date: start.date,
    time: start.allDay ? null : clockIn(start.at, timeZone),
  };
}

const DONE = /^✓\s*/;

/** What the person typed as notes: the description without the app's own detail and link. */
export function notesFrom(description: string | undefined, expected: Pick<ExportEvent, 'url' | 'description'>): string {
  let text = (description ?? '').replace(/\r\n/g, '\n');
  if (expected.url) text = text.split(expected.url).join('');
  const detail = expected.description.replace(expected.url, '').trim();
  if (detail) text = text.replace(detail, '');
  return text.replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1000);
}

function sameWhen(a: { at: number; allDay: boolean } | null, allDay: boolean, start: number): boolean {
  return !!a && a.allDay === allDay && a.at === start;
}

/**
 * What a changed Google event means. `written` is what the sync last wrote for it, which the change
 * is measured against (so a change made in the app meanwhile isn't mistaken for one made in
 * Google); `event` is the app's view now, whose items carry the edits. `isEcho` was checked before:
 * this is someone's change, not our own write coming back.
 */
export function readChange(g: GoogleEvent, written: Written | undefined, event: ExportEvent | undefined, timeZone: string, formatter: (t: number, allDay: boolean) => string): Reading {
  if (!event || !written) return { ignore: true };
  const at = g.updated ? Date.parse(g.updated) : Date.now();
  const series = written.series;
  // One occurrence of a series.
  if (g.recurringEventId) {
    if (!series || !event.series) return { revert: true };
    const original = startOf(g.originalStartTime, timeZone);
    if (!original) return { ignore: true };
    const day = series.time ? original.date : allDayOf(original.at, timeZone);
    const item = event.items.find((i) => i.series?.original === day) ?? event.items[0];
    if (g.status === 'cancelled') {
      if (series.exdates.includes(day)) return { ignore: true };
      return { edits: [{ kind: 'skip', event, item, values: { original: day }, at, from: formatter(occurrenceAt(series, day, timeZone), !series.time) }] };
    }
    const override = series.overrides.find((o) => o.original === day);
    const expectedStart = override ? override.start : occurrenceAt(series, day, timeZone);
    const expectedAllDay = override ? override.allDay : !series.time;
    const now = startOf(g.start, timeZone);
    const edits: Edit[] = [];
    if (!sameWhen(now, expectedAllDay, expectedStart)) {
      const values = moveValues(g, timeZone);
      if (!values) return { revert: true };
      // Already where the app has it now (a retried run): nothing to do.
      const current = event.series.overrides.find((o) => o.original === day);
      const already = sameWhen(now, current ? current.allDay : !event.series.time, current ? current.start : occurrenceAt(event.series, day, timeZone));
      if (!already) edits.push({ kind: 'reschedule', event, item, values: { ...values, original: day }, at, from: formatter(expectedStart, expectedAllDay), to: formatter(values.start!, values.time === null) });
    }
    const title = (g.summary ?? '').replace(DONE, '').trim();
    const expectedTitle = (override ?? written).title.replace(DONE, '').trim();
    if (title && title !== expectedTitle && edits.length === 0) return { revert: true };
    return edits.length ? { edits } : { ignore: true };
  }
  const item = event.items[0];
  if (!item) return { revert: true };
  if (g.status === 'cancelled') {
    return { edits: [{ kind: series ? 'hide' : 'cancel', event, item, values: {}, at, from: formatter(written.start, written.allDay) }] };
  }
  const edits: Edit[] = [];
  const title = (g.summary ?? '').replace(DONE, '').trim();
  if (title && title !== written.title.replace(DONE, '').trim()) edits.push({ kind: 'rename', event, item, values: { title: title.slice(0, 120) }, at, from: written.title, to: title.slice(0, 120) });
  if ((g.description ?? '') !== written.description) {
    const notes = notesFrom(g.description, written);
    if (notes !== notesFrom(written.description, written)) edits.push({ kind: 'notes', event, item, values: { notes }, at, to: notes.slice(0, 200) });
  }
  const now = startOf(g.start, timeZone);
  if (!sameWhen(now, written.allDay, written.start)) {
    const values = moveValues(g, timeZone);
    if (!values) return { revert: true };
    if (series) {
      // The whole series at another time of day, on the same days: a new usual time.
      const sameDays = now && !now.allDay && series.time && now.date === series.first;
      if (!sameDays) return { revert: true };
      edits.push({ kind: 'retime', event, item, values: { time: values.time }, at, from: series.time, to: values.time ?? '' });
    } else {
      edits.push({ kind: 'reschedule', event, item, values, at, from: formatter(written.start, written.allDay), to: formatter(values.start!, values.time === null) });
    }
  }
  if (series && g.recurrence && !sameRecurrence(g.recurrence, series.rule.freq)) return { revert: true };
  // What the app already has (a retried run, or the same change made in the app too) is no change.
  const needed = edits.filter((e) => {
    if (e.kind === 'rename') return e.values.title !== event.title.replace(DONE, '').trim();
    if (e.kind === 'notes') return e.values.notes !== notesFrom(event.description, event);
    if (e.kind === 'reschedule') return e.values.start !== event.start || (e.values.time === null) !== event.allDay;
    if (e.kind === 'retime') return e.values.time !== event.series?.time;
    return true;
  });
  return needed.length ? { edits: needed } : { ignore: true };
}

const occurrenceAt = (series: Pick<ExportSeries, 'rule' | 'time' | 'minutes' | 'first' | 'exdates'>, day: Ymd, timeZone: string): number => {
  const at = recurrenceIdOf({ ...series, overrides: [] }, day, timeZone);
  return typeof at === 'string' ? zonedTime(at, undefined, timeZone) : at;
};

/** Whether Google's RRULE still repeats the way ours does (EXDATEs may differ: those are skips, seen one by one). */
function sameRecurrence(lines: string[], freq: string): boolean {
  const rule = lines.find((l) => l.startsWith('RRULE:'));
  return !rule || rule.includes(`FREQ=${({ week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' } as Record<string, string>)[freq]};`) || rule.endsWith(`FREQ=${({ week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' } as Record<string, string>)[freq]}`);
}

/** Dates in the person's words for the history: "Thu, Oct 2, 7:00 AM". */
export function dateFormatter(lang: Lang, timeZone: string): (t: number, allDay: boolean) => string {
  const locale = DEFAULT_LOCALES[lang] ?? 'en-US';
  const day = new Intl.DateTimeFormat(locale, { timeZone, weekday: 'short', month: 'short', day: 'numeric' });
  const time = new Intl.DateTimeFormat(locale, { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (t, allDay) => (allDay ? day : time).format(new Date(t));
}

// ---- Applying ----

export type Outcome = 'applied' | 'already' | 'refused' | 'conflict' | 'gone';

const listOf = (item: AgendaItem) => (item.audience ? 'personalAgenda' : 'agenda');

/** An agenda item as stored again, without its id. */
const stored = ({ id: _id, ...rest }: AgendaItem): Record<string, unknown> => JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;

function withDeletes(v: unknown): unknown {
  if (v === DELETE_FIELD) return new FieldDelete();
  if (Array.isArray(v)) return v.map(withDeletes);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withDeletes(x)]));
  return v;
}

export interface ApplyContext {
  person: Person;
  view: View;
  /** The person's day ('$today'). */
  today: Ymd;
  now: number;
  timeZone: string;
  /** Agenda items of the event's record, all of them (for renames and retimes). */
  items: AgendaItem[];
}

/** The agenda writes that carry the change over to the household's agenda, and their undo. */
function agendaChange(edit: Edit, ctx: ApplyContext): { writes: Op[]; undo: Op[] } {
  const me = ctx.view.email;
  const touch = (i: AgendaItem, patch: Partial<AgendaItem>) => ({ ...stored(i), ...patch, updatedAt: ctx.now, by: me });
  const writes: Op[] = [];
  const undo: Op[] = [];
  const replace = (i: AgendaItem, next: Record<string, unknown>, nextId: string) => {
    if (nextId !== i.id) {
      writes.push({ col: listOf(i), id: i.id, data: null });
      undo.push({ col: listOf(i), id: nextId, data: null });
    }
    writes.push({ col: listOf(i), id: nextId, data: next });
    undo.push({ col: listOf(i), id: i.id, data: stored(i) });
  };
  const { kind, values, item } = edit;
  if (kind === 'reschedule') {
    const occurrence = item.series && values.original ? ctx.items.find((i) => i.series?.original === values.original) : item;
    if (occurrence) {
      const allDay = values.time === null;
      const start = values.start!;
      const end = values.end !== undefined && values.end > start ? values.end : undefined;
      const next = touch(occurrence, { start, allDay, ...(end !== undefined ? { end } : {}) });
      if (end === undefined) delete next.end;
      replace(occurrence, next, agendaId(occurrence.app, occurrence.ref, start));
    }
  } else if (kind === 'retime' && values.time) {
    for (const i of ctx.items.filter((x) => x.series && !x.allDay)) {
      const day = dayIn(i.start, ctx.timeZone);
      const start = zonedTime(day, values.time, ctx.timeZone);
      const length = i.end !== undefined ? i.end - i.start : undefined;
      const next = touch(i, { start, ...(length !== undefined ? { end: start + length } : {}), series: { ...i.series!, time: values.time } });
      replace(i, next, agendaId(i.app, i.ref, start));
    }
  } else if (kind === 'rename' && values.title) {
    for (const i of item.series ? ctx.items : [item]) {
      const texts = i.texts ? Object.fromEntries(Object.entries(i.texts).map(([l, t]) => [l, { ...t, title: values.title }])) : undefined;
      replace(i, touch(i, { title: values.title, ...(texts ? { texts } : {}) }), i.id);
    }
  } else if (kind === 'skip') {
    const occurrence = ctx.items.find((i) => i.series?.original === values.original);
    if (occurrence) {
      writes.push({ col: listOf(occurrence), id: occurrence.id, data: null });
      undo.push({ col: listOf(occurrence), id: occurrence.id, data: stored(occurrence) });
    }
  } else if (kind === 'cancel') {
    for (const i of edit.event.items) {
      writes.push({ col: listOf(i), id: i.id, data: null });
      undo.push({ col: listOf(i), id: i.id, data: stored(i) });
    }
  }
  return { writes, undo };
}

const CHANGE_NAMES: Record<AgendaEditKind, string> = { reschedule: 'moved', retime: 'retimed', rename: 'renamed', notes: 'notes', skip: 'skipped', cancel: 'cancelled' };

/** The id of the history entry: the same change applied twice (a retried run) is refused the second time. */
export const changeId = (gid: string, at: number, kind: string) => `g${contentHash(`${gid}|${at}|${kind}`)}`;

/**
 * Applies one edit as the person, all at once: the app's writes, the agenda's, and the history
 * entry (created only if new, so a retry can't apply it twice).
 */
export async function applyEdit(edit: Edit & { gid: string }, ctx: ApplyContext): Promise<Outcome> {
  if (edit.kind === 'hide') return 'refused';
  const kind = edit.kind;
  const { item } = edit;
  const updated = Math.max(...(item.series ? ctx.items : [item]).map((i) => i.updatedAt));
  if (updated > edit.at) return 'conflict';
  const action = item.edit?.[kind];
  if (!action || !canEdit(item, kind, ctx.view.role, ctx.view.email)) return 'refused';
  let ops: Op[];
  try {
    ops = resolveOps(fillEditOps(action.ops, edit.values), { now: ctx.now, me: ctx.view.email, today: ctx.today });
  } catch {
    return 'refused';
  }
  const db = ctx.person.db;
  const base = ctx.person.base;
  const before = new Map<string, { id: string } | undefined>();
  for (const op of ops) {
    const key = `${op.col}/${op.id}`;
    if (before.has(key)) continue;
    const doc = await db.get(`${base}/${op.col}/${op.id}`);
    before.set(key, doc ? { id: op.id, ...doc.data } : undefined);
  }
  // A merge onto a record deleted in the app: nothing to change.
  if (ops.some((op) => op.merge && !before.get(`${op.col}/${op.id}`))) return 'gone';
  const sourceUndo = inverseOps(ops, (col, id) => before.get(`${col}/${id}`));
  const agenda = agendaChange(edit, ctx);
  const undo = [...sourceUndo, ...agenda.undo];
  const toWrite = (op: Op): Write =>
    op.data === null ? { path: `${base}/${op.col}/${op.id}`, delete: true } : op.merge ? { path: `${base}/${op.col}/${op.id}`, merge: withDeletes(op.data) as Record<string, unknown> } : { path: `${base}/${op.col}/${op.id}`, set: op.data as Record<string, unknown> };
  const title = (item.texts?.en?.title ?? item.title).slice(0, 120) || '—';
  const entry = {
    email: ctx.view.email,
    source: 'google',
    app: item.app,
    ref: item.ref,
    title: edit.kind === 'rename' && edit.from ? edit.from.slice(0, 120) : title,
    change: CHANGE_NAMES[kind],
    ...(edit.from ? { from: edit.from.slice(0, 200) } : {}),
    ...(edit.to ? { to: edit.to.slice(0, 200) } : {}),
    // Undo writes the records back; when there are too many to keep, the app's own first.
    undo: JSON.parse(JSON.stringify(undo.length <= 12 ? undo : sourceUndo.slice(0, 12))) as unknown[],
    at: ctx.now,
    by: ctx.view.email,
  };
  try {
    await db.commit([...ops.map(toWrite), ...agenda.writes.map(toWrite), { path: `${base}/calendarChanges/${changeId(edit.gid, edit.at, kind)}`, create: entry }]);
  } catch (e) {
    if (e instanceof FirestoreError && e.code === 'already-exists') return 'already';
    if (e instanceof FirestoreError && (e.code === 'permission-denied' || e.code === 'invalid-argument' || e.code === 'failed-precondition')) return 'refused';
    throw e;
  }
  return 'applied';
}

