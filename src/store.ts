import type { Lang } from '@huishouden/pwa-kit/i18n';
import { randomSecret, sha256 } from './b64';
import type { Env } from './env';
import { seal, unseal } from './seal';

/**
 * What the Worker keeps. KV holds sealed records (src/seal.ts): each person's (their Firebase
 * sign-in, the feed secret, Google's refresh token) and, per feed secret, whose it is. D1 holds the
 * sync state, keyed by `pid`, a hash of household and email, so no table holds an email.
 */

export interface GoogleLink {
  refreshToken: string;
  /** The "Huishouden" calendar the sync made. */
  calendarId: string;
  /** The Google account it is in, as Google says (shown in the portal). */
  account: string;
  scope: string;
  connectedAt: number;
}

export interface PersonRecord {
  household: string;
  /** Lowercase. */
  email: string;
  uid: string;
  /** The person's Firebase refresh token: the Worker acts as them with it. */
  refreshToken: string;
  lang: Lang;
  timeZone: string;
  feed?: { secret: string; createdAt: number };
  google?: GoogleLink;
  /** Set when Firebase said the sign-in is gone: the portal asks them to set it up again. */
  signedOut?: boolean;
}

export const personId = (household: string, email: string): Promise<string> => sha256(`${household}\u0000${email.trim().toLowerCase()}`);

const personKey = (pid: string) => `person:${pid}`;

export async function loadPerson(env: Env, pid: string): Promise<PersonRecord | null> {
  return unseal<PersonRecord>(env.SEAL_KEY, `person:${pid}`, await env.TOKENS.get(personKey(pid)));
}

export async function savePerson(env: Env, pid: string, record: PersonRecord): Promise<void> {
  await env.TOKENS.put(personKey(pid), await seal(env.SEAL_KEY, `person:${pid}`, record));
}

export async function deletePerson(env: Env, pid: string): Promise<void> {
  await env.TOKENS.delete(personKey(pid));
}

const feedKey = async (secret: string) => `feed:${await sha256(`feed\u0000${secret}`)}`;

/** A new feed secret for the person, its record sealed under the secret itself. */
export async function newFeed(env: Env, pid: string): Promise<string> {
  const secret = randomSecret(24);
  await env.TOKENS.put(await feedKey(secret), await seal(env.SEAL_KEY, `feed:${secret}`, { pid }));
  return secret;
}

/** Whose feed a secret is, or null for one that never was or was revoked. */
export async function feedOwner(env: Env, secret: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(secret)) return null;
  const record = await unseal<{ pid: string }>(env.SEAL_KEY, `feed:${secret}`, await env.TOKENS.get(await feedKey(secret)));
  return record?.pid ?? null;
}

export async function revokeFeed(env: Env, secret: string): Promise<void> {
  await env.TOKENS.delete(await feedKey(secret));
}

// ---- D1 ----

export interface PersonRow {
  pid: string;
  feed: number;
  google: number;
  sync_token: string | null;
  signal: string | null;
  full_at: number | null;
  last_sync: number | null;
  last_ok: number | null;
  last_error: string | null;
  notice: string | null;
  counts: string | null;
  created_at: number;
}

export interface EventRow {
  pid: string;
  key: string;
  event_id: string;
  hash: string;
  etag: string | null;
  overrides: string | null;
  written: string | null;
  hidden: number;
}

export async function personRow(env: Env, pid: string): Promise<PersonRow | null> {
  return env.DB.prepare('SELECT * FROM people WHERE pid = ?').bind(pid).first<PersonRow>();
}

export async function upsertPersonRow(env: Env, pid: string, fields: Partial<Omit<PersonRow, 'pid' | 'created_at'>>, now: number): Promise<void> {
  const cols = Object.keys(fields);
  const values = Object.values(fields);
  const insertCols = ['pid', 'created_at', ...cols];
  const placeholders = insertCols.map(() => '?').join(', ');
  const updates = cols.map((c) => `${c} = excluded.${c}`).join(', ');
  await env.DB.prepare(`INSERT INTO people (${insertCols.join(', ')}) VALUES (${placeholders}) ON CONFLICT(pid) DO ${updates ? `UPDATE SET ${updates}` : 'NOTHING'}`)
    .bind(pid, now, ...values)
    .run();
}

export async function deletePersonRows(env: Env, pid: string, { events = true, feed = true, person = true } = {}): Promise<void> {
  const statements = [];
  if (events) statements.push(env.DB.prepare('DELETE FROM events WHERE pid = ?').bind(pid));
  if (feed) statements.push(env.DB.prepare('DELETE FROM feeds WHERE pid = ?').bind(pid));
  if (person) statements.push(env.DB.prepare('DELETE FROM people WHERE pid = ?').bind(pid));
  if (statements.length) await env.DB.batch(statements);
}

export async function eventRows(env: Env, pid: string): Promise<EventRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM events WHERE pid = ?').bind(pid).all<EventRow>();
  return results;
}

export function putEventRow(env: Env, row: EventRow): D1PreparedStatement {
  return env.DB.prepare(
    'INSERT INTO events (pid, key, event_id, hash, etag, overrides, written, hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(pid, key) DO UPDATE SET event_id = excluded.event_id, hash = excluded.hash, etag = excluded.etag, overrides = excluded.overrides, written = excluded.written, hidden = excluded.hidden',
  ).bind(row.pid, row.key, row.event_id, row.hash, row.etag, row.overrides, row.written, row.hidden);
}

export function deleteEventRow(env: Env, pid: string, key: string): D1PreparedStatement {
  return env.DB.prepare('DELETE FROM events WHERE pid = ? AND key = ?').bind(pid, key);
}

/** People with Google connected, the longest unsynced first. */
export async function googlePeople(env: Env, limit: number): Promise<PersonRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM people WHERE google = 1 ORDER BY COALESCE(last_sync, 0) ASC LIMIT ?').bind(limit).all<PersonRow>();
  return results;
}
