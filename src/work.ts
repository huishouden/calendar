import type { Env, Fetch } from './env';
import { log } from './log';
import { CalendarApiError, isRateLimited } from './google/api';
import { GoogleAuthError } from './google/oauth';
import { openPerson, upsertPersonRow, type PersonRow } from './store';
import { runUnit, zeroCounts, type RoundKind } from './round';

export { dropFeed } from './store';

/**
 * The work a check found for a person (src/check.ts), one small unit per invocation: a step of their
 * feed's build or of a round of their Google sync (src/round.ts), each within the free plan's 10 ms
 * of CPU. Each unit runs as a queue message (`WORK`), or, when the queue can't take one, straight
 * from the cron (src/tick.ts); the next unit of a round follows at once, as its own invocation.
 *
 * - Per-person order: a unit holds the person's lease (`people.lease_until`); another unit for them
 *   waits for it to end, and the checks leave them alone meanwhile. A round works from what is in
 *   Firestore and Google at the time, so rounds for one person never undo each other.
 * - Google saying "too many requests" (429, or 403 with a rate reason) backs the person off,
 *   doubling from 30 seconds to an hour; nothing is asked of Google for them until then.
 * - A unit that leaves work (the rest of its round, or the other kind) hands it to the next unit.
 */

export const FEED = 1 as const;
export const SYNC = 2 as const;

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
  /** Runs the next unit as its own invocation (the cron's and the queue's: `env.SELF.work`), handing it on. */
  next?: (pid: string, handover: Handover) => Promise<unknown>;
  /** What the unit before handed on, when this unit comes straight from it. */
  handover?: Handover;
}

/**
 * What a unit hands the next in its chain of invocations: how many came before (past MAX_CHAIN the
 * queue takes over), the lease (its `lease_until`: the next unit holds the person without taking
 * them), and the round under way (sealed) and its kind: not written to D1 between units.
 */
export interface Handover {
  depth: number;
  lease: number;
  round: string | null;
  kind: number;
}

/**
 * Units one chain of invocations runs before the next goes to the queue (a fresh start). A request
 * may make 32 Worker invocations, each service binding call one of them
 * (https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/): half of that,
 * so a round of a busy household fits in one queue message. A call past the limit fails, and its
 * unit goes to the queue instead.
 */
export const MAX_CHAIN = 16;

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
  const handed = deps.handover;
  // Handed the lease by the unit before (a read), or taking it (a write).
  let held = handed ? await env.DB.prepare('SELECT * FROM people WHERE pid = ? AND lease_until = ?').bind(pid, handed.lease).first<PersonRow>() : null;
  const given = held && handed?.round ? handed : null;
  held ??= await env.DB.prepare(
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
  const lease = held.lease_until!;
  // The round under way (handed over, or on the row) while its work is still marked; otherwise sync first, then the feed.
  const roundKind = given ? given.kind : held.round ? (held.round_kind ?? 0) : 0;
  const going = roundKind && held.work & roundKind ? (roundKind as RoundKind) : 0;
  const kind: RoundKind | 0 = going || (held.work & SYNC ? SYNC : held.work & FEED ? FEED : 0);
  if (!kind) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM round_items WHERE pid = ?').bind(pid),
      env.DB.prepare('UPDATE people SET lease_until = NULL, queued_at = NULL, round = NULL, round_kind = NULL, round_at = NULL WHERE pid = ?').bind(pid),
    ]);
    return { done: true };
  }
  const name = kind === SYNC ? 'sync' : 'feed';
  let unit: Awaited<ReturnType<typeof runUnit>>;
  try {
    const record = await openPerson(env, pid, held.record);
    unit =
      record && (kind === SYNC ? record.google : record.feed)
        ? await runUnit(env, pid, kind, held, record, { ...deps, round: going && given ? given.round : undefined })
        : {
            // Nothing to do it for (the feed or Google is gone): the round goes too.
            done: true,
            step: 'none',
            limited: false,
            statements: [...(kind === SYNC ? [env.DB.prepare('UPDATE people SET google = 0 WHERE pid = ?').bind(pid)] : []), env.DB.prepare('DELETE FROM round_items WHERE pid = ?').bind(pid)],
            round: null,
            started: now,
            finished: kind,
            counts: zeroCounts(),
            calls: 0,
          };
  } catch (e) {
    // The round as the unit before left it: on the row, for whichever unit comes next.
    const keep = given ? [env.DB.prepare('UPDATE people SET round = ?, round_kind = ?, round_at = ? WHERE pid = ?').bind(given.round, given.kind, now, pid)] : [];
    if (isRateLimited(e)) return backOff(env, pid, held, now, name, keep);
    const reason = e instanceof CalendarApiError ? `google-${e.status}` : e instanceof GoogleAuthError ? `google-${e.kind}` : 'error';
    // A feed that couldn't be built keeps serving the last one; a sync's error shows in the portal.
    await env.DB.batch([
      ...keep,
      kind === SYNC
        ? env.DB.prepare('UPDATE people SET lease_until = NULL, last_sync = ?, last_error = ? WHERE pid = ?').bind(now, reason, pid)
        : env.DB.prepare('UPDATE people SET lease_until = NULL WHERE pid = ?').bind(pid),
    ]);
    log('work', { kind: name, ok: false, reason });
    return { retryAfter: 60, reason: 'error' };
  }
  const round = { round: unit.round, kind: unit.round ? kind : null, at: unit.round ? unit.started : null };
  if (unit.limited) return backOff(env, pid, held, now, name, [...unit.statements, env.DB.prepare('UPDATE people SET round = ?, round_kind = ?, round_at = ? WHERE pid = ?').bind(round.round, round.kind, round.at, pid)]);
  const depth = (handed?.depth ?? 0) + 1;
  const chain = !!deps.next && depth < MAX_CHAIN;
  if (!unit.done && chain) {
    // The round goes on in the next unit, straight away, handed over with the lease: nothing about
    // the person changes on their row meanwhile (rows written are a free-plan limit).
    if (unit.statements.length) await env.DB.batch(unit.statements);
    log('work', { kind: name, step: unit.step, ok: true, more: true, calls: unit.calls });
    const outcome = await deps.next!(pid, { depth, lease, round: unit.round, kind }).catch(() => null);
    // The next unit didn't run (it failed, or couldn't take the lease): the round onto the row, the
    // person let go of, and the queue.
    if (!outcome || typeof outcome !== 'object' || !('done' in outcome)) {
      await env.DB.prepare('UPDATE people SET lease_until = NULL, queued_at = ?, round = ?, round_kind = ?, round_at = ? WHERE pid = ? AND lease_until = ?').bind(now, round.round, round.kind, round.at, pid, lease).run();
      await send(env, pid);
    }
    return { done: true, kind: name, more: true };
  }
  const left = held.work & ~unit.finished;
  // The other kind next, in its own invocation with the lease; past MAX_CHAIN, or without one, the queue.
  const next = !!left && chain;
  const nextLease = next ? now + LEASE_MS + depth : null;
  // Work marked by a check while this unit ran (it can't: checks skip a held person) is kept anyway.
  const results = await env.DB.batch([
    ...unit.statements,
    env.DB.prepare(
      'UPDATE people SET work = work & ~?1, lease_until = ?2, backoff = 0, backoff_until = NULL, queued_at = CASE WHEN work & ~?1 != 0 THEN ?3 ELSE NULL END, round = ?4, round_kind = ?5, round_at = ?6 WHERE pid = ?7 RETURNING work',
    ).bind(unit.finished, nextLease, now, round.round, round.kind, round.at, pid),
  ]);
  const remaining = (results[results.length - 1].results as { work: number }[])[0]?.work ?? 0;
  log('work', { kind: name, step: unit.step, ok: true, more: remaining !== 0, calls: unit.calls });
  if (remaining) {
    if (next && nextLease) {
      const outcome = await deps.next!(pid, { depth, lease: nextLease, round: null, kind: 0 }).catch(() => null);
      // The next unit didn't run (it failed, or couldn't take the lease): let go of it, and queue the work.
      if (!outcome || typeof outcome !== 'object' || !('done' in outcome)) {
        await env.DB.prepare('UPDATE people SET lease_until = NULL WHERE pid = ? AND lease_until = ?').bind(pid, nextLease).run();
        await send(env, pid);
      }
    } else await send(env, pid);
  }
  return { done: true, kind: name, more: remaining !== 0 };
}

async function backOff(env: Env, pid: string, held: PersonRow, now: number, name: string, statements: D1PreparedStatement[]): Promise<WorkOutcome> {
  const n = held.backoff + 1;
  const wait = backoffSeconds(n);
  await env.DB.batch([
    ...statements,
    env.DB.prepare('UPDATE people SET lease_until = NULL, backoff = ?, backoff_until = ?, last_error = ? WHERE pid = ?').bind(n, now + wait * 1000, 'google-rate', pid),
  ]);
  log('work', { kind: name, ok: false, reason: 'rate-limited', backoff: wait });
  return { retryAfter: wait, reason: 'backoff' };
}

/** A feed older than this is rebuilt (marked stale by a request) even when the signal says nothing changed. */
export const FEED_MAX_AGE_MS = 24 * 3_600_000;

/**
 * The person's feed, worked out as them and stored sealed for its URL (src/store.ts `putFeed`):
 * what a feed request serves. All of its units, one after another in this invocation: for tests and
 * the command line; the Worker runs one unit per invocation (`runWork`).
 */
export async function buildFeed(env: Env, pid: string, deps: Omit<WorkDeps, 'next' | 'handover'> = {}): Promise<void> {
  await runRound(env, pid, FEED, deps);
}

/** Every unit of a round of `kind` for the person, in this invocation, without the lease. */
export async function runRound(env: Env, pid: string, kind: RoundKind, deps: Omit<WorkDeps, 'next' | 'handover'> = {}) {
  const now = deps.now ?? Date.now();
  for (let i = 0; i < 1000; i++) {
    const row = await env.DB.prepare('SELECT * FROM people WHERE pid = ?').bind(pid).first<PersonRow>();
    const record = row ? await openPerson(env, pid, row.record) : null;
    if (!row || !record || !(kind === SYNC ? record.google : record.feed)) {
      if (kind === SYNC) await upsertPersonRow(env, pid, { google: 0 }, now);
      return null;
    }
    const unit = await runUnit(env, pid, kind, row, record, deps);
    await env.DB.batch([
      ...unit.statements,
      env.DB.prepare('UPDATE people SET work = work & ~?1, round = ?2, round_kind = ?3, round_at = ?4 WHERE pid = ?5').bind(unit.finished, unit.round, unit.round ? kind : null, unit.round ? unit.started : null, pid),
    ]);
    if (unit.done || unit.limited) return unit;
  }
  throw new Error('round did not finish');
}
