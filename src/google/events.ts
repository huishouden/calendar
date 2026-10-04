import { EXPORT_PROPERTY, exportMark, recurrenceIdOf, seriesRecurrence, type ExportEvent, type ExportSeries } from '@huishouden/pwa-kit/calendar-export';
import { icsDate, icsLocal, icsUtc, zonedTime } from '@huishouden/pwa-kit/ics';
import { addDays, type Ymd } from '@huishouden/pwa-kit/time';
import { base32hex, utf8 } from '../b64';
import type { GoogleDateTime } from './api';

/**
 * Export events as Google Calendar events. Each has an id made from the person and the event's
 * key, so writing the same event twice can't make two (Google refuses a second insert with the
 * same id), and the private `huishouden` property the calendar import skips.
 */

/** Google event ids: base32hex, 5 to 1024 characters. 32 characters from SHA-256 of the person and key. */
export async function eventId(pid: string, key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(`${pid}\u0000${key}`)));
  return `hh${base32hex(digest).slice(0, 30)}`;
}

/** "2031-10-02T07:00:00" on the zone's wall clock. */
export function localIso(t: number, timeZone: string): string {
  const s = icsLocal(t, timeZone);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}`;
}

const when = (e: Pick<ExportEvent, 'allDay' | 'startDate' | 'endDate' | 'start' | 'end'>, timeZone: string): { start: GoogleDateTime; end: GoogleDateTime } =>
  e.allDay
    ? { start: { date: e.startDate! }, end: { date: e.endDate! } }
    : { start: { dateTime: localIso(e.start, timeZone), timeZone }, end: { dateTime: localIso(e.end, timeZone), timeZone } };

/** The RRULE and EXDATE lines Google takes in `recurrence`. */
export function recurrenceLines(series: ExportSeries, timeZone: string): string[] {
  const { rrule, exdates } = seriesRecurrence(series, timeZone);
  const lines = [`RRULE:${rrule}`];
  const days = exdates.filter((d): d is Ymd => typeof d === 'string');
  const times = exdates.filter((d): d is number => typeof d === 'number');
  if (days.length) lines.push(`EXDATE;VALUE=DATE:${days.map(icsDate).join(',')}`);
  if (times.length) lines.push(`EXDATE;TZID=${timeZone}:${times.map((t) => icsLocal(t, timeZone)).join(',')}`);
  return lines;
}

const TRANSPARENT = ['task', 'todo', 'due'];

/** The whole event as written: a one-off, or a series' master with its recurrence. */
export function googleBody(e: ExportEvent, { id, householdId, timeZone }: { id: string; householdId: string; timeZone: string }): Record<string, unknown> {
  return {
    id,
    status: 'confirmed',
    summary: e.title,
    description: e.description,
    ...(e.location ? { location: e.location } : {}),
    ...when(e, timeZone),
    ...(e.series ? { recurrence: recurrenceLines(e.series, timeZone) } : {}),
    transparency: TRANSPARENT.includes(e.kind) ? 'transparent' : 'opaque',
    reminders: e.alarmMinutes !== undefined ? { useDefault: false, overrides: [{ method: 'popup', minutes: e.alarmMinutes }] } : { useDefault: true },
    extendedProperties: { private: { [EXPORT_PROPERTY]: exportMark(householdId, e.key), hhApp: e.app } },
    ...(/^https?:\/\//.test(e.url) ? { source: { title: 'Huishouden', url: e.url } } : {}),
  };
}

/** The id Google gives one occurrence of a series: the master's, then its original start (UTC, or the day when all day). */
export function instanceId(masterId: string, series: ExportSeries, original: Ymd, timeZone: string): string {
  const at = recurrenceIdOf(series, original, timeZone);
  return `${masterId}_${typeof at === 'string' ? icsDate(at) : icsUtc(at)}`;
}

/** A moved occurrence: its own time and words. */
export function overrideBody(o: ExportEvent, timeZone: string): Record<string, unknown> {
  return { status: 'confirmed', summary: o.title, description: o.description, ...when(o, timeZone) };
}

/** An occurrence put back on its usual day and time. */
export function regularBody(master: ExportEvent, original: Ymd, timeZone: string): Record<string, unknown> {
  const s = master.series!;
  if (!s.time) return { status: 'confirmed', summary: master.title, description: master.description, start: { date: original }, end: { date: addDays(original, 1) } };
  const start = zonedTime(original, s.time, timeZone);
  return { status: 'confirmed', summary: master.title, description: master.description, start: { dateTime: localIso(start, timeZone), timeZone }, end: { dateTime: localIso(start + s.minutes * 60_000, timeZone), timeZone } };
}
