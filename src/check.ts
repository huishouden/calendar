import type { Env, Fetch } from './env';
import { log } from './log';
import { NotMember, overQuota, Person, signalExtra, signInGone, type Shared } from './person';
import { accessToken, GoogleAuthError } from './google/oauth';
import { Calendar, CalendarApiError, isRateLimited, SyncTokenGone } from './google/api';
import { eventRows, feedRowOf, openPerson, savePerson, upsertPersonRow, type PersonRow } from './store';
import { FULL_EVERY_MS, isEcho } from './sync';
import { dropFeed, FEED, markWork, SYNC } from './work';

/**
 * The cheap check, for a few people at a time (one fan-out invocation, src/tick.ts): has anything
 * they see changed? It never builds a feed or writes to Google; it marks the work and queues it
 * (src/work.ts). Nothing is written when nothing changed.
 *
 * - Google: `events.list` with the sync token. Only our own writes coming back (echoes): the token
 *   moves on here. A real change: sync.
 * - The household: the change signal (src/person.ts): the household and their settings in one
 *   request, a count and sum per list. The household's shared lists are read once for all its
 *   members in the run.
 * - Due anyway: a sync not fully rebuilt in 6 hours, a feed a request marked stale.
 */

/** Subrequests per invocation on the free plan; the checks stop short of it. */
export const SUBREQUESTS = 50;
/** The most one person's check can take: token, change list, Google token, batchGet, four aggregations. */
const PERSON_MAX = 8;
/** Firestore over its quota: no checks for this long (the cron reads the pause from `meta`). */
export const FIRESTORE_PAUSE_MS = 15 * 60_000;

export interface CheckDeps {
  fetch?: Fetch;
  now?: number;
  firestoreUrl?: string;
}

export interface CheckTotals {
  checked: number;
  marked: number;
  sent: number;
  echoes: number;
  skipped: number;
  errors: number;
  /** People left for another invocation: this one's subrequests ran out. */
  deferred: string[];
  paused: boolean;
}

export async function checkPeople(env: Env, pids: string[], deps: CheckDeps = {}): Promise<CheckTotals> {
  const now = deps.now ?? Date.now();
  const totals: CheckTotals = { checked: 0, marked: 0, sent: 0, echoes: 0, skipped: 0, errors: 0, deferred: [], paused: false };
  if (pids.length === 0) return totals;
  let calls = 0;
  const base = deps.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const counted: Fetch = (url, init) => {
    calls++;
    return base(url, init);
  };
  const { results } = await env.DB.prepare(`SELECT * FROM people WHERE pid IN (${pids.map(() => '?').join(', ')}) ORDER BY hh, pid`)
    .bind(...pids)
    .all<PersonRow>();
  const shared: Shared = new Map();
  let done = 0;
  for (const row of results) {
    // Token exchanges go through each isolate's caches, outside `counted`: two per person kept for them.
    if (calls + 2 * done + PERSON_MAX > SUBREQUESTS) {
      totals.deferred.push(row.pid);
      continue;
    }
    done++;
    if ((row.lease_until && row.lease_until > now) || (row.backoff_until && row.backoff_until > now)) {
      totals.skipped++;
      continue;
    }
    try {
      const kinds = await checkOne(env, row, { ...deps, fetch: counted, now }, shared, totals);
      totals.checked++;
      if (kinds) {
        totals.marked++;
        if (await markWork(env, row.pid, kinds, now)) totals.sent++;
      }
    } catch (e) {
      if (overQuota(e)) {
        await env.DB.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind('firestore-pause', now + FIRESTORE_PAUSE_MS).run();
        totals.paused = true;
        log('check', { paused: 'firestore-quota' });
        break;
      }
      totals.errors++;
      if (isRateLimited(e)) {
        const n = row.backoff + 1;
        await env.DB.prepare('UPDATE people SET backoff = ?, backoff_until = ? WHERE pid = ?').bind(n, now + Math.min(3600, 30 * 2 ** (n - 1)) * 1000, row.pid).run();
      }
    }
  }
  return totals;
}

/** The work one person needs (FEED | SYNC), or 0. */
async function checkOne(env: Env, row: PersonRow, deps: CheckDeps & { fetch: Fetch; now: number }, shared: Shared, totals: CheckTotals): Promise<number> {
  const { now } = deps;
  const record = await openPerson(env, row.pid, row.record);
  if (!record) return 0;
  let kinds = row.work & (FEED | SYNC);
  // Google access removed and recorded: nothing to sync until they connect again (which clears it).
  const google = row.google === 1 && record.google && row.last_error !== 'google-revoked' ? record.google : null;

  // Google's side first: a change there is work whatever the household did.
  if (google && !(kinds & SYNC)) {
    let calendar: Calendar | null = null;
    try {
      calendar = new Calendar(await accessToken(env, google.refreshToken, deps.fetch, now), deps.fetch);
    } catch (e) {
      // Revoked: the sync records it (once: see `google` above). Google unreachable: the next check tries again.
      if (e instanceof GoogleAuthError && e.kind === 'revoked') kinds |= SYNC;
    }
    if (calendar) {
      try {
        const answer = await calendar.changes(google.calendarId, row.sync_token, 1);
        if (!answer.complete || !row.sync_token) kinds |= SYNC;
        else if (answer.items.length) {
          const rows = await eventRows(env, row.pid);
          const byId = new Map(rows.map((r) => [r.event_id, r]));
          const real = answer.items.filter((g) => !isEcho(g, byId.get(g.recurringEventId ?? g.id)));
          totals.echoes += answer.items.length - real.length;
          if (real.length) kinds |= SYNC;
          else if (answer.nextSyncToken) {
            // Only our own writes: the token moves on, unless a sync moved it meanwhile.
            await env.DB.prepare('UPDATE people SET sync_token = ? WHERE pid = ? AND sync_token = ?').bind(answer.nextSyncToken, row.pid, row.sync_token).run();
          }
        }
      } catch (e) {
        if (e instanceof SyncTokenGone || (e instanceof CalendarApiError && (e.status === 404 || e.status === 410))) kinds |= SYNC;
        else throw e;
      }
    }
  }

  // The household's side.
  const person = new Person(env, record, deps.fetch, deps.firestoreUrl);
  let signal: string;
  try {
    const view = await person.view();
    signal = await person.signal(view, signalExtra(view, record), shared);
  } catch (e) {
    if (e instanceof NotMember) {
      if (record.feed) await dropFeed(env, row.pid, now);
      if (google && row.last_error !== 'not-member') await upsertPersonRow(env, row.pid, { last_sync: now, last_error: 'not-member' }, now);
      return 0;
    }
    if (signInGone(e)) {
      if (!record.signedOut) await savePerson(env, row.pid, { ...record, signedOut: true });
      if (google && row.last_error !== 'signed-out') await upsertPersonRow(env, row.pid, { last_sync: now, last_error: 'signed-out' }, now);
      return 0;
    }
    throw e;
  }
  if (google && (signal !== row.signal || !row.full_at || now - row.full_at > FULL_EVERY_MS)) kinds |= SYNC;
  if (record.feed && row.feed === 1) {
    const feed = await feedRowOf(env, row.pid);
    if (!feed || feed.signal !== signal || feed.stale) kinds |= FEED;
  }
  return kinds;
}
