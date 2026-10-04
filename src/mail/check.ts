import type { Env, Fetch } from '../env';
import { log } from '../log';
import { slotsFor } from '../tick';
import { accessToken, GoogleAuthError } from '../google/oauth';
import { Gmail, gmailRateLimited, HistoryGone } from './gmail';
import { searchFor } from './inbox';
import { PARSER_VERSION } from './recheck';
import { openConfig, openRecord, STOPPED, unseen, type InboxRow } from './store';
import { CONFIG_MAX_AGE_MS, markMailWork, sendMail, stopInbox } from './work';

/**
 * The alert inboxes' checks: every MAIL_EVERY_MIN minutes per inbox, a few inboxes per invocation
 * (`SELF.mail`), fanned out by the cron after the calendar's checks. A check reads no Firestore and
 * writes nothing when nothing arrived:
 *
 * 1. Gmail's history since the last history id: did any mail arrive? (one request)
 * 2. If so, the household's alert search since `since` (one request), against the seen list.
 * 3. Unread alerts: the inbox is marked and a unit of import queued (src/mail/work.ts).
 *
 * The household's cards and rules are kept sealed with the inbox (read as the member at most every
 * 12 hours, or on Check now), so the search needs no Firestore read.
 */

export const MAIL_EVERY_MIN = 5;
/** Inboxes per check invocation: at most about 7 requests each (token, history pages, profile, search), of 50. */
export const MAIL_CHUNK = 6;
const SUBREQUESTS = 50;
const INBOX_MAX = 7;
/** A check that only moved the history id writes it at most this often (the search is cheap to repeat). */
export const QUIET_WRITE_MS = 30 * 60_000;
const SWEEP = 10;

export interface MailTotals {
  checked: number;
  arrived: number;
  searched: number;
  queued: number;
  skipped: number;
  errors: number;
  deferred: string[];
}

export interface MailCheckDeps {
  fetch?: Fetch;
  now?: number;
  firestoreUrl?: string;
}

export async function checkInboxes(env: Env, ids: string[], deps: MailCheckDeps = {}): Promise<MailTotals> {
  const now = deps.now ?? Date.now();
  const totals: MailTotals = { checked: 0, arrived: 0, searched: 0, queued: 0, skipped: 0, errors: 0, deferred: [] };
  if (!ids.length) return totals;
  const fetchImpl: Fetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const { results } = await env.DB.prepare(`SELECT * FROM inboxes WHERE id IN (${ids.map(() => '?').join(',')})`)
    .bind(...ids)
    .all<InboxRow>();
  let calls = 0;
  for (const row of results) {
    if (calls + INBOX_MAX > SUBREQUESTS) {
      totals.deferred.push(row.id);
      continue;
    }
    if ((row.error && STOPPED.includes(row.error)) || (row.lease_until && row.lease_until > now) || (row.backoff_until && row.backoff_until > now)) {
      totals.skipped++;
      continue;
    }
    const configOld = !row.config_at || now - row.config_at >= CONFIG_MAX_AGE_MS;
    const reread = row.rechecked < PARSER_VERSION && !row.error;
    if (row.pending || configOld || reread) {
      // Owed a search (or the cards are old, or past imports are to be read again): the import unit does it, with the household's latest.
      if (await markMailWork(env, row.id, now)) totals.queued++;
      totals.checked++;
      continue;
    }
    const config = await openConfig(env, row);
    const record = await openRecord(env, row);
    if (!config || !record) {
      if (await markMailWork(env, row.id, now, { refreshConfig: true })) totals.queued++;
      continue;
    }
    const query = searchFor(config, row.since);
    if (!query) {
      // Nothing to search for until someone adds alert words; the config is read again in 12 hours.
      totals.skipped++;
      continue;
    }
    let gmail: Gmail | undefined;
    try {
      calls++;
      gmail = new Gmail(await accessToken(env, record.google, deps.fetch, now), fetchImpl);
      let historyId = row.history_id;
      let arrived = false;
      if (!historyId) {
        historyId = (await gmail.profile()).historyId;
        arrived = true;
      } else {
        try {
          const h = await gmail.history(historyId);
          arrived = h.added > 0;
          historyId = h.historyId;
        } catch (e) {
          if (!(e instanceof HistoryGone)) throw e;
          historyId = (await gmail.profile()).historyId;
          arrived = true;
        }
      }
      totals.checked++;
      if (!arrived) {
        // Nothing new: the history id moves on now and then (other changes move it too), or when an error clears.
        if (row.error || (historyId !== row.history_id && (!row.checked_at || now - row.checked_at >= QUIET_WRITE_MS))) {
          await env.DB.prepare('UPDATE inboxes SET history_id = ?, since = ?, checked_at = ?, error = NULL WHERE id = ?').bind(historyId, now, now, row.id).run();
        }
        continue;
      }
      totals.arrived++;
      totals.searched++;
      const fresh = await unseen(env, row.id, await gmail.search(query, 100));
      if (fresh.length) {
        await env.DB.prepare('UPDATE inboxes SET history_id = ?, checked_at = ? WHERE id = ?').bind(historyId, now, row.id).run();
        if (await markMailWork(env, row.id, now)) totals.queued++;
      } else if (historyId !== row.history_id && (!row.checked_at || now - row.checked_at >= QUIET_WRITE_MS || row.error)) {
        // Mail arrived, none of it alerts: everything before now has been read.
        await env.DB.prepare('UPDATE inboxes SET history_id = ?, since = ?, checked_at = ?, error = NULL WHERE id = ?').bind(historyId, now, now, row.id).run();
      }
    } catch (e) {
      totals.errors++;
      if (e instanceof GoogleAuthError && e.kind === 'revoked') await stopInbox(env, row, 'revoked', deps, now);
      else if (gmailRateLimited(e)) {
        const n = row.backoff + 1;
        await env.DB.prepare('UPDATE inboxes SET backoff = ?, backoff_until = ? WHERE id = ?').bind(n, now + Math.min(3600, 30 * 2 ** (n - 1)) * 1000, row.id).run();
      } else if (row.error !== 'gmail') await env.DB.prepare("UPDATE inboxes SET error = 'gmail' WHERE id = ?").bind(row.id).run();
    } finally {
      calls += gmail?.calls ?? 0;
    }
  }
  return totals;
}

/**
 * The inboxes due this minute, checked in invocations of their own (at most `calls`, what the
 * calendar's checks left of the cron's), then import work the queue never got.
 */
export async function runMailCron(env: Env, { now = Date.now(), calls = 30, ...deps }: MailCheckDeps & { calls?: number } = {}): Promise<Record<string, number>> {
  const minute = Math.floor(now / 60_000) % 60;
  const totals: Record<string, number> = { due: 0, calls: 0, checked: 0, arrived: 0, searched: 0, queued: 0, skipped: 0, errors: 0, failed: 0, deferred: 0, swept: 0 };
  const slots = slotsFor(minute, MAIL_EVERY_MIN);
  const { results } = await env.DB.prepare(`SELECT id FROM inboxes WHERE shard IN (${slots.join(',')}) ORDER BY id`).all<{ id: string }>();
  totals.due = results.length;
  const check = (ids: string[]): Promise<MailTotals> => (env.SELF ? env.SELF.mail(ids) : checkInboxes(env, ids, { ...deps, now }));
  let waiting: string[][] = [];
  for (let i = 0; i < results.length; i += MAIL_CHUNK) waiting.push(results.slice(i, i + MAIL_CHUNK).map((r) => r.id));
  while (waiting.length && totals.calls < calls) {
    const wave = waiting.slice(0, calls - totals.calls);
    waiting = waiting.slice(wave.length);
    totals.calls += wave.length;
    const answers = await Promise.allSettled(wave.map(check));
    const deferred: string[] = [];
    for (const a of answers) {
      if (a.status === 'rejected') {
        totals.failed++;
        continue;
      }
      for (const k of ['checked', 'arrived', 'searched', 'queued', 'skipped', 'errors'] as const) totals[k] += a.value[k];
      deferred.push(...a.value.deferred);
    }
    for (let i = 0; i < deferred.length; i += MAIL_CHUNK) waiting.unshift(deferred.slice(i, i + MAIL_CHUNK));
  }
  totals.deferred = waiting.reduce((n, c) => n + c.length, 0);

  // Import work marked but not on its way (the queue refused it, or the message was lost).
  const stuck = await env.DB.prepare('SELECT id FROM inboxes WHERE pending != 0 AND (queued_at IS NULL OR queued_at < ?1) AND (lease_until IS NULL OR lease_until <= ?2) AND (backoff_until IS NULL OR backoff_until <= ?2) LIMIT ?3')
    .bind(now - 10 * 60_000, now, SWEEP)
    .all<{ id: string }>();
  for (const { id } of stuck.results) {
    totals.swept++;
    await env.DB.prepare('UPDATE inboxes SET queued_at = ? WHERE id = ?').bind(now, id).run();
    if (await sendMail(env, id)) continue;
    if (totals.calls >= calls || !env.SELF) break;
    totals.calls++;
    await env.SELF.mailWork(id).catch(() => null);
  }

  if (!totals.failed && totals.deferred === 0 && totals.due > 0) {
    await env.DB.prepare('INSERT INTO mail_ticks (minute, at) VALUES (?, ?) ON CONFLICT(minute) DO UPDATE SET at = excluded.at').bind(minute, now).run();
  }
  if (totals.due || totals.swept) log('mail-tick', { minute, ...totals });
  return totals;
}
