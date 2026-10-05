import { toAgendaItem } from '@huishouden/pwa-kit/agenda-core';
import { DEFAULT_CALENDAR_SETTINGS, exportEvents, exportIcs, loadExportLang } from '@huishouden/pwa-kit/calendar-export';
import { decodeFields, encodeFields } from '@huishouden/pwa-kit/firestore-rest';
import { batchBody, parseBatch } from './google/api';
import { googleBody } from './google/events';
import { snapshot } from './backsync';
import { assembleIcs, eventIcs, keepWitness, partition } from './round';

/** Zones warmed at startup: the runtime's zone data for each, used by the VTIMEZONE and the clock. */
const ZONES = ['Europe/Amsterdam', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'UTC'];

/**
 * Run once when the isolate starts (src/index.ts), outside any invocation's CPU time: a small
 * invented calendar decoded as Firestore returns it, exported as a feed and as Google events, its
 * writes batched, in the common zones (and the other languages' catalogues loaded). Without it, the first build
 * or sync round in an isolate pays for loading the language catalogues and the zone data and for
 * compiling this code: measured in workerd, 18 ms against 3 to 5 ms warm for 63 events. Cloudflare
 * limits startup separately (1 second).
 */
export function warm(): void {
  try {
    const day = Date.UTC(2031, 9, 2, 5);
    const raw = [
      { app: 'home', ref: 'event:w', kind: 'other', title: 'Bins', start: day, end: day + 1_800_000, allDay: false, private: false, series: { rule: { freq: 'week', every: 1, start: '2031-09-04' }, time: '07:00', minutes: 30, original: '2031-10-02', through: '2031-10-30' }, edit: { rename: { ops: [{ col: 'homeEvents', id: 'w', data: { title: '$title', updatedAt: '$now' }, merge: true }], roles: ['admin', 'member'] } }, texts: { es: { title: 'Basura' } }, updatedAt: 1 },
      { app: 'baby', ref: 'appointment:w', kind: 'appointment', title: 'Checkup', start: day + 86_400_000, allDay: false, private: false, updatedAt: 1 },
      { app: 'bills', ref: 'bill:w', kind: 'bill', title: 'Bill', start: day + 2 * 86_400_000, allDay: true, private: true, status: 'upcoming', updatedAt: 1 },
    ];
    // As Firestore's REST answer arrives: JSON, typed values, decoded.
    const wire = JSON.parse(JSON.stringify(raw.map((d, i) => ({ document: { name: `x/agenda/w${i}`, fields: encodeFields(d) } })))) as { document: { name: string; fields: never } }[];
    const agenda = wire.map((d) => toAgendaItem(d.document.name.split('/').pop()!, decodeFields(d.document.fields)));
    parseBatch(`--b\r\nContent-ID: <response-item1>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"etag":"\\"1\\""}\r\n--b--`, 'b', 1);
    // Spanish and Dutch: only their catalogues, whose import may finish after startup; work done
    // when it finishes would land in the first invocation.
    void loadExportLang('es').catch(() => undefined);
    void loadExportLang('nl').catch(() => undefined);
    for (const lang of ['en'] as const) {
      void loadExportLang(lang)
        // Synchronous only: anything awaiting the event loop (WebCrypto) would run in the first
        // invocation instead of at startup, and cost it the CPU this is meant to save.
        .then(() => {
          for (const timeZone of ZONES) {
            const events = exportEvents({ agenda, todos: [], me: 'warm@invalid', role: 'admin', lang, timeZone, settings: DEFAULT_CALENDAR_SETTINGS });
            exportIcs(events, { householdId: 'warm', timeZone, lang, now: day });
            // The same calendar as a round's units make it (src/round.ts).
            const input = { me: 'warm@invalid', role: 'admin' as const, settings: DEFAULT_CALENDAR_SETTINGS };
            partition({ agenda, todos: [] }, input, 2);
            const options = { householdId: 'warm', timeZone, lang, now: day };
            assembleIcs(events.map((e) => ({ s: e.start, k: e.key, t: eventIcs(e, options) })), keepWitness([], events, 'warm', timeZone, lang), options);
            const bodies = events.map((e) => (snapshot(e), googleBody(e, { id: 'warm', householdId: 'warm', timeZone })));
            batchBody('b', bodies.map((body) => ({ method: 'PUT' as const, path: '/calendars/warm/events/warm', body })));
          }
        })
        .catch(() => undefined);
    }
  } catch {
    // Warming is only ever an optimisation.
  }
}
