import { FirestoreError } from '@huishouden/pwa-kit/firestore-rest';
import { FirebaseAuthError } from '@huishouden/pwa-kit/firebase-auth-rest';
import type { Env, Fetch } from './env';
import { log } from './log';
import { NotMember, overQuota, Person, signalExtra, signInGone, type Shared } from './person';
import { accessToken, GoogleAuthError } from './google/oauth';
import { Calendar, CalendarApiError, isRateLimited, SyncTokenGone } from './google/api';
import { eventRows, openPerson, savePerson, upsertPersonRow, type PersonRecord, type PersonRow } from './store';
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
  /**
   * The cron's checks pass the minutes between a Google person's checks: their household side is
   * then read every `QUIET_EVERY_MIN` while it is quiet (`householdDue`). Without it (a feed fetch,
   * the portal) every check reads it.
   */
  googleEvery?: number;
}

/** A household whose signal changed within this long is checked at every Google check (5 minutes). */
export const ACTIVE_MS = 60 * 60_000;
/** Otherwise its household side is read at most every this many minutes; Google's side still every check. */
export const QUIET_EVERY_MIN = 15;

/**
 * Whether this check reads the person's household side (their view and the four aggregations, about
 * 6 billed reads). Google's side costs no Firestore reads and is checked every time. A household
 * that changed in the last hour is read at every check; a quiet one at the first check of each
 * quarter hour of the person's slot (`shard`), so a first change after a quiet spell reaches Google
 * within 15 minutes and the ones after it within 5. With checks 15 or more minutes apart (the read
 * budget's), every check reads it.
 */
export function householdDue(row: Pick<PersonRow, 'shard' | 'hh_signal' | 'hh_signal_at'>, now: number, googleEvery: number | undefined): boolean {
  if (!googleEvery || googleEvery >= QUIET_EVERY_MIN) return true;
  if (!row.hh_signal) return true;
  if (row.hh_signal_at && now - row.hh_signal_at < ACTIVE_MS) return true;
  const quarter = QUIET_EVERY_MIN * 60_000;
  const offset = row.shard * 60_000;
  return Math.floor((now - offset) / quarter) !== Math.floor((now - googleEvery * 60_000 - offset) / quarter);
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
  /** Google people whose household side wasn't due this time (quiet: see `householdDue`). */
  quiet: number;
}

export async function checkPeople(env: Env, pids: string[], deps: CheckDeps = {}): Promise<CheckTotals> {
  const now = deps.now ?? Date.now();
  const totals: CheckTotals = { checked: 0, marked: 0, sent: 0, echoes: 0, skipped: 0, errors: 0, deferred: [], paused: false, quiet: 0 };
  if (pids.length === 0) return totals;
  let calls = 0;
  const base = deps.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const counted: Fetch = (url, init) => {
    calls++;
    return base(url, init);
  };
  // Each person with their feed's signal, in one read.
  const { results } = await env.DB.prepare(
    `SELECT people.*, feeds.signal AS feed_signal, feeds.stale AS feed_stale FROM people LEFT JOIN feeds ON feeds.pid = people.pid WHERE people.pid IN (${pids.map(() => '?').join(', ')}) ORDER BY people.hh, people.pid`,
  )
    .bind(...pids)
    .all<CheckRow>();
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
      // The kind only (no person, no message text that could carry one).
      log('check', { error: e instanceof FirestoreError ? `firestore-${e.code}` : e instanceof CalendarApiError ? `google-${e.status}` : e instanceof GoogleAuthError ? `google-${e.kind}` : e instanceof FirebaseAuthError ? `firebase-${e.kind}` : e instanceof Error ? e.name : 'unknown' });
      if (isRateLimited(e)) {
        const n = row.backoff + 1;
        await env.DB.prepare('UPDATE people SET backoff = ?, backoff_until = ? WHERE pid = ?').bind(n, now + Math.min(3600, 30 * 2 ** (n - 1)) * 1000, row.pid).run();
      }
    }
  }
  return totals;
}

type CheckRow = PersonRow & { feed_signal: string | null; feed_stale: number | null };

/** The work one person needs (FEED | SYNC), or 0. */
async function checkOne(env: Env, row: CheckRow, deps: CheckDeps & { fetch: Fetch; now: number }, shared: Shared, totals: CheckTotals): Promise<number> {
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

  // The household's side: only when due (`householdDue`); the reasons a sync or feed is due anyway still count.
  kinds |= dueAnyway(row, record, now, !!google);
  if (google && !householdDue(row, now, deps.googleEvery)) {
    totals.quiet++;
    return kinds;
  }
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
  if (signal !== row.hh_signal) {
    // Seen changing (not the first time it is seen): the household counts as active for an hour.
    await env.DB.prepare('UPDATE people SET hh_signal = ?, hh_signal_at = ? WHERE pid = ?').bind(signal, row.hh_signal ? now : 0, row.pid).run();
  }
  if (google && signal !== row.signal) kinds |= SYNC;
  if (record.feed && row.feed === 1 && (!row.feed_signal || row.feed_signal !== signal)) kinds |= FEED;
  return kinds;
}

/** The work due whatever the household did: a sync not fully rebuilt in FULL_EVERY_MS, a feed a request marked stale. */
export function dueAnyway(row: Pick<CheckRow, 'full_at' | 'feed' | 'feed_stale'>, record: Pick<PersonRecord, 'feed'>, now: number, google: boolean): number {
  let kinds = 0;
  if (google && (!row.full_at || now - row.full_at > FULL_EVERY_MS)) kinds |= SYNC;
  if (record.feed && row.feed === 1 && row.feed_stale) kinds |= FEED;
  return kinds;
}
