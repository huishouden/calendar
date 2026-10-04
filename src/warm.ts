import { toAgendaItem } from '@huishouden/pwa-kit/agenda-core';
import { DEFAULT_CALENDAR_SETTINGS, exportEvents, exportIcs, loadExportLang } from '@huishouden/pwa-kit/calendar-export';
import { googleBody } from './google/events';

/**
 * Run once when the isolate starts (src/index.ts), outside any request's CPU time: a small invented
 * calendar exported as a feed and as Google events, in every language. Without it, the first build
 * in an isolate pays for loading the language catalogues, the runtime's time zone data and compiling
 * the export, which is most of a cold build's CPU. Cloudflare limits startup separately (1 second).
 */
export function warm(): void {
  try {
    const day = Date.UTC(2031, 9, 2, 5);
    const agenda = [
      toAgendaItem('w1', { app: 'home', ref: 'event:w', kind: 'other', title: 'Bins', start: day, end: day + 1_800_000, allDay: false, private: false, series: { rule: { freq: 'week', every: 1, start: '2031-09-04' }, time: '07:00', minutes: 30, original: '2031-10-02', through: '2031-10-30' }, updatedAt: 1 }),
      toAgendaItem('w2', { app: 'baby', ref: 'appointment:w', kind: 'appointment', title: 'Checkup', start: day + 86_400_000, allDay: false, private: false, updatedAt: 1 }),
      toAgendaItem('w3', { app: 'bills', ref: 'bill:w', kind: 'bill', title: 'Bill', start: day + 2 * 86_400_000, allDay: true, private: true, status: 'upcoming', updatedAt: 1 }),
    ];
    for (const lang of ['en', 'es', 'nl'] as const) {
      void loadExportLang(lang).then(() => {
        const events = exportEvents({ agenda, todos: [], me: 'warm@invalid', role: 'admin', lang, timeZone: 'Europe/Amsterdam', settings: DEFAULT_CALENDAR_SETTINGS });
        exportIcs(events, { householdId: 'warm', timeZone: 'Europe/Amsterdam', lang, now: day });
        for (const e of events) googleBody(e, { id: 'warm', householdId: 'warm', timeZone: 'Europe/Amsterdam' });
      });
    }
  } catch {
    // Warming is only ever an optimisation.
  }
}
