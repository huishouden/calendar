import type { AlertCard, CategoryRule } from '@huishouden/pwa-kit/spending-core';
import { sha256 } from '../b64';
import type { Env } from '../env';
import { seal, unseal } from '../seal';
import { householdKey } from '../store';

/**
 * What the Worker keeps for an alert inbox (migrations/0003_mail.sql). Everything that names a person
 * or an address, and the household's search, is sealed; the row itself holds only times and states.
 */

export interface InboxRecord {
  household: string;
  /** The member who connected it, lowercase: the checker acts as them. */
  email: string;
  uid: string;
  /** Their Firebase refresh token. */
  refreshToken: string;
  /** Google's refresh token for the inbox's account (gmail.readonly). */
  google: string;
  /** The Gmail address, as Google says. */
  address: string;
  /** The household's time zone, for an alert's day. */
  timeZone: string;
  connectedAt: number;
}

/** The household's cards, alert labels and category rules, as the member read them: what the search and the parser use. */
export interface InboxConfig {
  cards: AlertCard[];
  labels: string[];
  rules: CategoryRule[];
}

export interface InboxRow {
  id: string;
  hh: string;
  shard: number;
  record: string;
  config: string | null;
  config_at: number | null;
  history_id: string | null;
  since: number;
  pending: number;
  checked_at: number | null;
  found_at: number | null;
  added: number | null;
  error: string | null;
  queued_at: number | null;
  lease_until: number | null;
  backoff_until: number | null;
  backoff: number;
  created_at: number;
}

/** Errors that stop the checks until someone acts: reconnect, or rejoin. */
export const STOPPED = ['revoked', 'not-member', 'signed-out'];

/** The inbox's id: also its Firestore document's (huishouden/rules `spendingInboxes`, `[A-Za-z0-9_-]{1,64}`). */
export const inboxIdOf = async (household: string, address: string): Promise<string> => `ib-${(await sha256(`inbox\u0000${household}\u0000${address.trim().toLowerCase()}`)).slice(0, 32)}`;

/** The minute slot (0..59), from the hash part of the id. */
export const inboxShard = (id: string): number => (id.charCodeAt(3) * 64 + id.charCodeAt(4)) % 60;

export const openRecord = (env: Env, row: Pick<InboxRow, 'id' | 'record'>): Promise<InboxRecord | null> => unseal<InboxRecord>(env.SEAL_KEY, `inbox:${row.id}`, row.record);

export const openConfig = (env: Env, row: Pick<InboxRow, 'id' | 'config'>): Promise<InboxConfig | null> =>
  row.config ? unseal<InboxConfig>(env.SEAL_KEY, `inbox-config:${row.id}`, row.config) : Promise.resolve(null);

export const sealConfig = (env: Env, id: string, config: InboxConfig): Promise<string> => seal(env.SEAL_KEY, `inbox-config:${id}`, config);

export async function inboxRow(env: Env, id: string): Promise<InboxRow | null> {
  return env.DB.prepare('SELECT * FROM inboxes WHERE id = ?').bind(id).first<InboxRow>();
}

export async function householdInboxes(env: Env, household: string): Promise<InboxRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM inboxes WHERE hh = ? ORDER BY created_at').bind(await householdKey(household)).all<InboxRow>();
  return results;
}

/** A new or reconnected inbox: owed a search from `since` (the backfill). */
export async function putInbox(env: Env, id: string, record: InboxRecord, { since, historyId, now }: { since: number; historyId: string | null; now: number }): Promise<void> {
  const sealed = await seal(env.SEAL_KEY, `inbox:${id}`, record);
  await env.DB.prepare(
    `INSERT INTO inboxes (id, hh, shard, record, history_id, since, pending, error, config, config_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, NULL, NULL, NULL, ?7)
     ON CONFLICT(id) DO UPDATE SET record = excluded.record, history_id = excluded.history_id, since = MIN(inboxes.since, excluded.since),
       pending = 1, error = NULL, config = NULL, config_at = NULL, backoff = 0, backoff_until = NULL`,
  )
    .bind(id, await householdKey(record.household), inboxShard(id), sealed, historyId, since, now)
    .run();
}

export async function deleteInbox(env: Env, id: string): Promise<void> {
  await env.DB.batch([env.DB.prepare('DELETE FROM inboxes WHERE id = ?').bind(id), env.DB.prepare('DELETE FROM inbox_seen WHERE inbox = ?').bind(id)]);
}

/** Of `ids`, those not read before for this inbox. */
export async function unseen(env: Env, inbox: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const seen = new Set<string>();
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT msg FROM inbox_seen WHERE inbox = ? AND msg IN (${part.map(() => '?').join(',')})`)
      .bind(inbox, ...part)
      .all<{ msg: string }>();
    for (const r of results) seen.add(r.msg);
  }
  return ids.filter((id) => !seen.has(id));
}

export const SEEN_KEEP_MS = 45 * 24 * 3_600_000;

export function markSeen(env: Env, inbox: string, ids: string[], now: number): D1PreparedStatement[] {
  return ids.map((msg) => env.DB.prepare('INSERT OR IGNORE INTO inbox_seen (inbox, msg, at) VALUES (?, ?, ?)').bind(inbox, msg, now));
}

/** The last time every inbox in the slot was checked (the cron's ticks), or 0. */
export async function lastMailTick(env: Env, shard: number, every: number): Promise<number> {
  const minutes = Array.from({ length: 60 / every }, (_, i) => (shard % every) + i * every);
  const row = await env.DB.prepare(`SELECT MAX(at) AS at FROM mail_ticks WHERE minute IN (${minutes.join(',')})`).first<{ at: number | null }>();
  return row?.at ?? 0;
}
