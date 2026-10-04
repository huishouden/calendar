import { toMailMessage } from '@huishouden/pwa-kit/mail-core';
import { dayOf, planAlerts, transactionDoc, MAX_ALERTS, type Existing } from '@huishouden/pwa-kit/spending-core';
import type { Env, Fetch } from '../env';
import { log } from '../log';
import { overQuota, signInGone } from '../person';
import { accessToken, GoogleAuthError, revokeGoogle } from '../google/oauth';
import { REQUEUE_MS, type WorkOutcome } from '../work';
import { Gmail, gmailRateLimited } from './gmail';
import { actingAs, readConfig, refused, reportInbox, searchFor } from './inbox';
import { deleteInbox, markSeen, openConfig, openRecord, sealConfig, SEEN_KEEP_MS, unseen, type InboxConfig, type InboxRow } from './store';

/**
 * One unit of an inbox's import, in its own invocation (a queue message `{ inbox }`, or the next
 * unit called through `SELF.mailWork`): search Gmail for the household's alerts since the inbox's
 * `since`, read up to PER_UNIT messages not read before, parse them with the kit's spending-core
 * (exactly as the app does), and write the new ones as `spendingTransactions` in the member's name.
 * A unit that leaves messages hands the rest to the next unit, so each stays within the free plan's
 * 10 ms of CPU.
 *
 * Nothing from a message is kept or logged: only the transaction the parser makes of it (date,
 * merchant, amount, category, card), which is what the app writes too, and its Gmail id in the seen
 * list.
 */

/** Messages read per unit: parsing an alert's HTML takes about a millisecond. */
export const PER_UNIT = 3;
/** The household's cards and rules are read again after this. */
export const CONFIG_MAX_AGE_MS = 12 * 3_600_000;
export const LEASE_MS = 2 * 60_000;
const BACKOFF_FIRST_S = 30;
const BACKOFF_MAX_S = 3600;

export interface MailWorkDeps {
  fetch?: Fetch;
  now?: number;
  firestoreUrl?: string;
  /** Runs the next unit as its own invocation. */
  next?: (id: string) => Promise<unknown>;
}

/** Marks the inbox as owed a search and sends one queue message for it, unless one is on its way. Returns whether one was sent. */
export async function markMailWork(env: Env, id: string, now: number, { refreshConfig = false } = {}): Promise<boolean> {
  const claim = now + Math.random() * 0.999;
  const row = await env.DB.prepare(
    `UPDATE inboxes SET pending = 1, config_at = CASE WHEN ?1 THEN NULL ELSE config_at END,
       queued_at = CASE WHEN queued_at IS NULL OR queued_at < ?2 THEN ?3 ELSE queued_at END WHERE id = ?4 RETURNING queued_at`,
  )
    .bind(refreshConfig ? 1 : 0, now - REQUEUE_MS, claim, id)
    .first<{ queued_at: number | null }>();
  if (!row || row.queued_at !== claim) return false;
  return sendMail(env, id);
}

export async function sendMail(env: Env, id: string): Promise<boolean> {
  try {
    if (!env.WORK) throw new Error('no queue');
    await env.WORK.send({ inbox: id });
    return true;
  } catch {
    // The queue's daily operations used up: the cron's sweep runs it.
    await env.DB.prepare('UPDATE inboxes SET queued_at = NULL WHERE id = ?').bind(id).run();
    return false;
  }
}

const backoffSeconds = (n: number) => Math.min(BACKOFF_MAX_S, BACKOFF_FIRST_S * 2 ** Math.max(0, n - 1));

/** Stops the inbox's checks with an error the app shows (Reconnect), and says so on its document when it can. */
export async function stopInbox(env: Env, row: Pick<InboxRow, 'id' | 'record'>, error: string, deps: Pick<MailWorkDeps, 'fetch' | 'firestoreUrl'>, now: number): Promise<void> {
  await env.DB.prepare('UPDATE inboxes SET error = ?, pending = 0, lease_until = NULL, queued_at = NULL, checked_at = ? WHERE id = ?').bind(error, now, row.id).run();
  const record = await openRecord(env, row);
  if (record && error !== 'not-member' && error !== 'signed-out') await reportInbox(actingAs(env, record, deps.fetch, deps.firestoreUrl), row.id, { error }, now).catch(() => undefined);
  log('mail', { stopped: error });
}

export async function runMailWork(env: Env, id: string, deps: MailWorkDeps = {}): Promise<WorkOutcome> {
  const now = deps.now ?? Date.now();
  const fetchImpl: Fetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const row = await env.DB.prepare(
    'UPDATE inboxes SET lease_until = ?1 WHERE id = ?2 AND (lease_until IS NULL OR lease_until <= ?3) AND (backoff_until IS NULL OR backoff_until <= ?3) RETURNING *',
  )
    .bind(now + LEASE_MS, id, now)
    .first<InboxRow>();
  if (!row) {
    const held = await env.DB.prepare('SELECT lease_until, backoff_until FROM inboxes WHERE id = ?').bind(id).first<{ lease_until: number | null; backoff_until: number | null }>();
    if (!held) return { done: true };
    if (held.backoff_until && held.backoff_until > now) return { retryAfter: Math.ceil((held.backoff_until - now) / 1000), reason: 'backoff' };
    return { retryAfter: 30, reason: 'busy' };
  }
  const release = (fields: string, ...values: unknown[]) =>
    env.DB.prepare(`UPDATE inboxes SET lease_until = NULL${fields ? `, ${fields}` : ''} WHERE id = ?`)
      .bind(...values, id)
      .run();
  if (!row.pending) {
    await release('queued_at = NULL');
    return { done: true };
  }
  const pause = await env.DB.prepare("SELECT value FROM meta WHERE key = 'firestore-pause'").first<{ value: number }>();
  if (pause && pause.value > now) {
    await release('');
    return { retryAfter: Math.ceil((pause.value - now) / 1000), reason: 'backoff' };
  }
  const record = await openRecord(env, row);
  if (!record) {
    await deleteInbox(env, id);
    return { done: true };
  }
  const person = actingAs(env, record, deps.fetch, deps.firestoreUrl);
  try {
    // The household's cards and rules: kept sealed for checks, read again when old or asked.
    let config: InboxConfig | null = row.config_at && now - row.config_at < CONFIG_MAX_AGE_MS ? await openConfig(env, row) : null;
    if (!config) {
      config = await readConfig(person);
      await env.DB.prepare('UPDATE inboxes SET config = ?, config_at = ? WHERE id = ?').bind(await sealConfig(env, id, config), now, id).run();
    }
    const query = searchFor(config, row.since);
    if (!query) {
      await release("pending = 0, queued_at = NULL, error = 'nothing-to-search', checked_at = ?", now);
      await reportInbox(person, id, { error: 'nothing-to-search' }, now);
      log('mail', { unit: true, nothing: true });
      return { done: true };
    }

    const gmail = new Gmail(await accessToken(env, record.google, deps.fetch, now), fetchImpl);
    const started = now;
    const found = await gmail.search(query, MAX_ALERTS);
    const fresh = await unseen(env, id, found);
    // Gmail lists newest first; the oldest are read first, so a unit's alerts keep their order.
    const batch = fresh.slice(-PER_UNIT).reverse();
    const more = fresh.length > batch.length;
    let added = 0;
    let duplicates = 0;
    if (batch.length) {
      const messages = (await Promise.all(batch.map((m) => gmail.get(m)))).map(toMailMessage);
      const from = dayOf(Math.min(...messages.map((m) => m.date)) - 4 * 86_400_000, record.timeZone);
      const existing: Existing[] = (await person.db.query(person.base, 'spendingTransactions', { where: [{ field: 'date', op: 'GREATER_THAN_OR_EQUAL', value: from }] })).map((d) => ({
        id: d.id,
        date: String(d.data.date ?? ''),
        description: String(d.data.description ?? ''),
        amount: typeof d.data.amount === 'number' ? d.data.amount : Number(d.data.amount) || 0,
        card: String(d.data.card ?? ''),
        source: String(d.data.source ?? 'statement'),
      }));
      const plan = planAlerts(messages, { cards: config.cards, rules: config.rules, existing, timeZone: record.timeZone });
      added = plan.create.length;
      duplicates = plan.duplicates;
      if (added) {
        await person.db.commit(plan.create.map((tx) => ({ path: `${person.base}/spendingTransactions/${tx.id}`, set: transactionDoc(tx, 'alert', record.email, now) })));
      }
      // The document says what was found (and that the inbox works again); gone means disconnected.
      const present = await reportInbox(person, id, added ? { lastAlertAt: now, lastAdded: added, error: null } : { error: null }, now);
      if (!present) {
        await revokeGoogle(record.google, deps.fetch);
        await deleteInbox(env, id);
        log('mail', { unit: true, gone: true });
        return { done: true };
      }
      await env.DB.batch([
        ...markSeen(env, id, batch, now),
        env.DB.prepare('DELETE FROM inbox_seen WHERE inbox = ? AND at < ?').bind(id, now - SEEN_KEEP_MS),
      ]);
    } else if (row.error) {
      await reportInbox(person, id, { error: null }, now);
    }
    await release(
      `pending = ?, since = ?, error = NULL, backoff = 0, backoff_until = NULL, checked_at = ?, queued_at = ?${added ? ', found_at = ?, added = ?' : ''}`,
      more ? 1 : 0,
      more ? row.since : started,
      now,
      more ? now : null,
      ...(added ? [now, added] : []),
    );
    log('mail', { unit: true, found: found.length, read: batch.length, added, duplicates, more });
    if (more) {
      if (deps.next) await deps.next(id).catch(() => sendMail(env, id));
      else await sendMail(env, id);
    }
    return { done: true };
  } catch (e) {
    if (e instanceof GoogleAuthError && e.kind === 'revoked') {
      await stopInbox(env, row, 'revoked', deps, now);
      return { done: true };
    }
    if (signInGone(e)) {
      await stopInbox(env, row, 'signed-out', deps, now);
      return { done: true };
    }
    if (refused(e)) {
      await stopInbox(env, row, 'not-member', deps, now);
      return { done: true };
    }
    if (gmailRateLimited(e)) {
      const n = row.backoff + 1;
      const wait = backoffSeconds(n);
      await release('backoff = ?, backoff_until = ?', n, now + wait * 1000);
      log('mail', { unit: true, ok: false, reason: 'rate-limited', backoff: wait });
      return { retryAfter: wait, reason: 'backoff' };
    }
    const reason = overQuota(e) ? 'firestore' : 'gmail';
    await release('error = ?, checked_at = ?', reason, now);
    log('mail', { unit: true, ok: false, reason, kind: e instanceof Error ? e.constructor.name : typeof e });
    return { retryAfter: 60, reason: 'error' };
  }
}
