import { contentHash, exportEvents, exportIcs, loadExportLang } from '@huishouden/pwa-kit/calendar-export';
import { icsProblems } from '@huishouden/pwa-kit/ics';
import type { Env, Fetch } from './env';
import { log } from './log';
import { NotMember, Person, signalExtra, signInGone, zoneOf } from './person';
import { CalendarApiError, isRateLimited } from './google/api';
import { GoogleAuthError } from './google/oauth';
import { loadPerson, openPerson, putFeed, revokeFeed, savePerson, upsertPersonRow, type PersonRecord, type PersonRow } from './store';
import { syncPerson } from './sync';

/**
 * The work a check found for a person (src/check.ts), one small unit per invocation: rebuild their
 * feed, or one round of their Google sync (up to MAX_WRITES writes). Each unit runs as a queue
 * message (`WORK`), or, when the queue can't take one, straight from the cron (src/tick.ts).
 *
 * - Per-person order: a unit holds the person's lease (`people.lease_until`); another unit for them
 *   waits for it to end, and the checks leave them alone meanwhile. Each unit works from what is in
 *   Firestore and Google at the time, so units for one person never undo each other.
 * - Google saying "too many requests" (429, or 403 with a rate reason) backs the person off,
 *   doubling from 30 seconds to an hour; nothing is asked of Google for them until then.
 * - A unit that leaves work (the other kind, or more writes) hands it to the next unit at once.
 */

export const FEED = 1;
export const SYNC = 2;

/** How long a unit may hold the person; a unit that died lets go when it runs out. */
export const LEASE_MS = 2 * 60_000;
/** A queued message older than this is taken as lost; the cron sends the work again. */
export const REQUEUE_MS = 10 * 60_000;
const BACKOFF_FIRST_S = 30;
const BACKOFF_MAX_S = 3600;

export interface WorkMessage {
  pid: string;
}

export interface WorkDeps {
  fetch?: Fetch;
  now?: number;
  firestoreUrl?: string;
  /** Runs the next unit as its own invocation (the cron's and the queue's: `env.SELF.work`). */
  next?: (pid: string) => Promise<unknown>;
}

export type WorkOutcome =
  | { done: true; kind?: 'feed' | 'sync'; more?: boolean }
  | { retryAfter: number; reason: 'busy' | 'backoff' | 'error' };

const backoffSeconds = (n: number) => Math.min(BACKOFF_MAX_S, BACKOFF_FIRST_S * 2 ** Math.max(0, n - 1));

/**
 * Marks work for the person and sends one queue message for it, unless one is already on its way.
 * Returns whether a message was sent. Without a queue (or when it refuses: the free plan's daily
 * operations), the work stays marked and the cron runs it.
 */
export async function markWork(env: Env, pid: string, kinds: number, now: number, { queue = true } = {}): Promise<boolean> {
  if (!queue) {
    await env.DB.prepare('UPDATE people SET work = work | ? WHERE pid = ?').bind(kinds, pid).run();
    return false;
  }
  // The claim is the time plus a random fraction, so seeing our own value back means this call set it
  // (two marks in the same millisecond still send one message).
  const claim = now + Math.random() * 0.999;
  const row = await env.DB.prepare(
    'UPDATE people SET work = work | ?1, queued_at = CASE WHEN queued_at IS NULL OR queued_at < ?2 THEN ?3 ELSE queued_at END WHERE pid = ?4 RETURNING queued_at',
  )
    .bind(kinds, now - REQUEUE_MS, claim, pid)
    .first<{ queued_at: number | null }>();
  if (!row || row.queued_at !== claim) return false;
  return send(env, pid);
}

async function send(env: Env, pid: string): Promise<boolean> {
  if (!env.WORK) {
    await env.DB.prepare('UPDATE people SET queued_at = NULL WHERE pid = ?').bind(pid).run();
    return false;
  }
  try {
    await env.WORK.send({ pid } satisfies WorkMessage);
    return true;
  } catch {
    await env.DB.prepare('UPDATE people SET queued_at = NULL WHERE pid = ?').bind(pid).run();
    log('queue', { sent: false });
    return false;
  }
}

/** One unit of the person's work. */
export async function runWork(env: Env, pid: string, deps: WorkDeps = {}): Promise<WorkOutcome> {
  const now = deps.now ?? Date.now();
  const held = await env.DB.prepare(
    'UPDATE people SET lease_until = ?1 WHERE pid = ?2 AND (lease_until IS NULL OR lease_until <= ?3) AND (backoff_until IS NULL OR backoff_until <= ?3) RETURNING *',
  )
    .bind(now + LEASE_MS, pid, now)
    .first<PersonRow>();
  if (!held) {
    const row = await env.DB.prepare('SELECT lease_until, backoff_until FROM people WHERE pid = ?').bind(pid).first<{ lease_until: number | null; backoff_until: number | null }>();
    if (!row) return { done: true };
    if (row.backoff_until && row.backoff_until > now) return { retryAfter: Math.ceil((row.backoff_until - now) / 1000), reason: 'backoff' };
    return { retryAfter: 30, reason: 'busy' };
  }
  const kind = held.work & SYNC ? SYNC : held.work & FEED ? FEED : 0;
  if (!kind) {
    await env.DB.prepare('UPDATE people SET lease_until = NULL, queued_at = NULL WHERE pid = ?').bind(pid).run();
    return { done: true };
  }
  let more = false;
  try {
    if (kind === SYNC) {
      const counts = await syncPerson(env, pid, { ...deps, row: held });
      if (counts.limited) throw new RateLimitedWrites();
      more = counts.more;
    } else await buildFeed(env, pid, { ...deps, record: await openPerson(env, pid, held.record) });
  } catch (e) {
    if (e instanceof RateLimitedWrites || isRateLimited(e)) {
      const n = held.backoff + 1;
      const wait = backoffSeconds(n);
      await env.DB.prepare('UPDATE people SET lease_until = NULL, backoff = ?, backoff_until = ?, last_error = ? WHERE pid = ?').bind(n, now + wait * 1000, 'google-rate', pid).run();
      log('work', { kind: kind === SYNC ? 'sync' : 'feed', ok: false, reason: 'rate-limited', backoff: wait });
      return { retryAfter: wait, reason: 'backoff' };
    }
    const reason = e instanceof CalendarApiError ? `google-${e.status}` : e instanceof GoogleAuthError ? `google-${e.kind}` : 'error';
    // A feed that couldn't be built keeps serving the last one; a sync's error shows in the portal.
    if (kind === SYNC) await env.DB.prepare('UPDATE people SET lease_until = NULL, last_sync = ?, last_error = ? WHERE pid = ?').bind(now, reason, pid).run();
    else await env.DB.prepare('UPDATE people SET lease_until = NULL WHERE pid = ?').bind(pid).run();
    log('work', { kind: kind === SYNC ? 'sync' : 'feed', ok: false, reason });
    return { retryAfter: 60, reason: 'error' };
  }
  const left = (held.work & ~kind) | (more ? kind : 0);
  // Work marked by a check while this unit ran (it can't: checks skip a held person) is kept anyway.
  const after = await env.DB.prepare('UPDATE people SET work = (work & ~?1) | ?2, lease_until = NULL, backoff = 0, backoff_until = NULL, queued_at = CASE WHEN ?2 != 0 THEN ?3 ELSE NULL END WHERE pid = ?4 RETURNING work')
    .bind(kind, left, now, pid)
    .first<{ work: number }>();
  const remaining = after?.work ?? 0;
  log('work', { kind: kind === SYNC ? 'sync' : 'feed', ok: true, more: remaining !== 0 });
  if (remaining) {
    // The next unit is its own invocation, with its own CPU time; without one, the queue.
    if (deps.next) await deps.next(pid).catch(() => send(env, pid));
    else await send(env, pid);
  }
  return { done: true, kind: kind === SYNC ? 'sync' : 'feed', more: remaining !== 0 };
}

class RateLimitedWrites extends Error {}

/** A feed older than this is rebuilt (marked stale by a request) even when the signal says nothing changed. */
export const FEED_MAX_AGE_MS = 24 * 3_600_000;

/**
 * The person's feed, worked out as them and stored sealed for its URL (src/store.ts `putFeed`):
 * what a feed request serves. Someone who left the household loses the feed.
 */
export async function buildFeed(env: Env, pid: string, deps: WorkDeps & { record?: PersonRecord | null } = {}): Promise<void> {
  const now = deps.now ?? Date.now();
  const record = deps.record !== undefined ? deps.record : await loadPerson(env, pid);
  if (!record?.feed) return;
  const person = new Person(env, record, deps.fetch, deps.firestoreUrl);
  try {
    const view = await person.view();
    const loaded = await person.load(view, now);
    const signal = person.signalOf(view, loaded, signalExtra(view, record));
    await loadExportLang(record.lang);
    const timeZone = zoneOf(view, record);
    const events = exportEvents({ ...loaded, me: record.email, role: view.role, lang: record.lang, timeZone, settings: view.settings, home: view.home?.address });
    const body = exportIcs(events, { householdId: record.household, timeZone, lang: record.lang, now });
    await putFeed(env, pid, record.feed.secret, { signal, etag: `"${contentHash(body)}"`, body, now });
    log('feed', { built: true, events: events.length, problems: icsProblems(body).length, lists: Object.entries(loaded.reads).map(([c, o]) => `${c}:${o}`).join(' ') });
  } catch (e) {
    if (e instanceof NotMember) {
      await dropFeed(env, pid, now);
      return;
    }
    if (signInGone(e)) {
      await savePerson(env, pid, { ...record, signedOut: true });
      log('feed', { built: false, reason: 'signed-out' });
      return;
    }
    throw e;
  }
}

/** They left the household: the feed goes, and so does what the Worker kept for it. */
export async function dropFeed(env: Env, pid: string, now: number): Promise<void> {
  const record = await loadPerson(env, pid);
  if (record?.feed) {
    await revokeFeed(env, record.feed.secret);
    await savePerson(env, pid, { ...record, feed: undefined });
  }
  await env.DB.prepare('DELETE FROM feeds WHERE pid = ?').bind(pid).run();
  await upsertPersonRow(env, pid, { feed: 0 }, now);
  log('feed', { served: 'gone' });
}
