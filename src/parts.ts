import { exportIcs, toIcsEvents, visibleTo, type ExportEvent, type ExportInput } from '@huishouden/pwa-kit/calendar-export';
import { CRLF, foldLine, veventLines } from '@huishouden/pwa-kit/ics';
import type { AgendaItem } from '@huishouden/pwa-kit/agenda-core';
import type { TodoItem } from '@huishouden/pwa-kit/todo-core';
import type { Loaded } from './person';

/**
 * A calendar in parts (src/round.ts): the lists cut into parts a unit can export, each event's
 * feed text on its own, and the feed put together from them, byte for byte what `exportIcs` writes
 * of the whole. Pure: nothing here reads or writes anything.
 */

/** Items (agenda items and to-dos) one unit exports at most. */
export const UNIT_ITEMS = 60;

/** One event's feed text, with what the feed is sorted by (its start, its key). */
export interface Piece {
  s: number;
  k: string;
  t: string;
}

/**
 * The lists cut into parts for the export, each at most `size` items (an app record's items stay
 * together: a series is one event), without what the person doesn't see, as even as that allows.
 * Exporting each part and sorting the events together gives exactly `exportEvents` of the whole.
 */
export function partition(loaded: Pick<Loaded, 'agenda' | 'todos'>, input: Pick<ExportInput, 'me' | 'role' | 'settings'>, size = UNIT_ITEMS): { agenda: AgendaItem[]; todos: TodoItem[] }[] {
  const groups = new Map<string, AgendaItem[]>();
  for (const item of loaded.agenda) {
    if (!visibleTo(item, input)) continue;
    const k = `${item.app}|${item.ref}`;
    const g = groups.get(k);
    if (g) g.push(item);
    else groups.set(k, [item]);
  }
  const todos = input.settings.todos
    ? (loaded.todos ?? []).filter((t) => t.status === 'open' && t.due !== undefined && !groups.has(`${t.app}|${t.ref}`) && visibleTo({ app: t.app, kind: 'task', private: t.private, audience: t.audience }, input))
    : [];
  const total = [...groups.values()].reduce((n, g) => n + g.length, 0) + todos.length;
  // As even as the size allows: 63 items go as 32 and 31, not 50 and 13.
  const even = Math.ceil(total / Math.max(1, Math.ceil(total / size)));
  const parts: { agenda: AgendaItem[]; todos: TodoItem[] }[] = [];
  let current = { agenda: [] as AgendaItem[], todos: [] as TodoItem[] };
  const add = (n: number) => {
    const has = current.agenda.length + current.todos.length;
    if (has > 0 && has + n > even) {
      parts.push(current);
      current = { agenda: [], todos: [] };
    }
  };
  for (const items of groups.values()) {
    add(items.length);
    current.agenda.push(...items);
  }
  for (const t of todos) {
    add(1);
    current.todos.push(t);
  }
  if (current.agenda.length + current.todos.length) parts.push(current);
  return parts;
}

/** One event's VEVENTs (the event, and a series' moved occurrences) as the feed writes them. */
export function eventIcs(e: ExportEvent, { householdId, timeZone, lang, now }: { householdId: string; timeZone: string; lang: ExportInput['lang']; now: number }): string {
  return toIcsEvents([e], { householdId, timeZone, lang }).flatMap((ie) => veventLines(ie, { timeZone, now })).map(foldLine).join(CRLF) + CRLF;
}

const bare = (e: ExportEvent): ExportEvent => {
  const { todo: _t, ...rest } = e;
  return { ...rest, items: [], ...(e.series ? { series: { ...e.series, overrides: e.series.overrides.map((o) => ({ ...o, items: [] })) } } : {}) };
};

/** The earliest year any of the event's VEVENTs touches, and whether any has a time. */
function yearOf(e: ExportEvent, householdId: string, timeZone: string, lang: ExportInput['lang']): { year: number; timed: boolean } {
  let year = Infinity;
  let timed = false;
  for (const ie of toIcsEvents([e], { householdId, timeZone, lang })) {
    const t = 'date' in ie.start ? Date.parse(`${ie.start.date}T00:00:00Z`) : ie.start.at;
    year = Math.min(year, new Date(t).getUTCFullYear());
    if (!('date' in ie.start)) timed = true;
  }
  return { year, timed };
}

/** Keeps, of `witness` and `events`, the ones that decide the header: the earliest year, and one with a time. */
export function keepWitness(witness: ExportEvent[], events: readonly ExportEvent[], householdId: string, timeZone: string, lang: ExportInput['lang']): ExportEvent[] {
  let earliest: { e: ExportEvent; year: number } | null = null;
  let timed: ExportEvent | null = null;
  for (const e of [...witness, ...events]) {
    const y = yearOf(e, householdId, timeZone, lang);
    if (!earliest || y.year < earliest.year) earliest = { e, year: y.year };
    if (!timed && y.timed) timed = e;
  }
  return [...new Set([earliest?.e, timed].filter((e): e is ExportEvent => !!e))].map(bare);
}

/**
 * The header `exportIcs` writes for the calendar (the time zone when any event has a time, from
 * the earliest year any event touches), cut from the calendar of the events that decide it.
 */
export function icsHeader(witness: readonly ExportEvent[], options: Parameters<typeof exportIcs>[1]): string {
  const text = exportIcs(witness, options);
  const at = text.indexOf(`BEGIN:VEVENT${CRLF}`);
  return text.slice(0, at >= 0 ? at : text.lastIndexOf(`END:VCALENDAR${CRLF}`));
}

/** The calendar from its events' text (any order) and the header's events: `exportIcs` of them all. */
export function assembleIcs(pieces: readonly Piece[], witness: readonly ExportEvent[], options: Parameters<typeof exportIcs>[1]): string {
  const sorted = [...pieces].sort((a, b) => a.s - b.s || a.k.localeCompare(b.k));
  return icsHeader(witness, options) + sorted.map((p) => p.t).join('') + `END:VCALENDAR${CRLF}`;
}
