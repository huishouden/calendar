import type { Lang } from '@huishouden/pwa-kit/i18n';
import { randomSecret, sha256 } from './b64';
import type { Env } from './env';
import { seal, unseal } from './seal';

/**
 * What the Worker keeps. D1 holds each person's sealed record (src/seal.ts: their Firebase sign-in,
 * the feed secret, Google's refresh token), the sync state and the precomputed feed, keyed by `pid`,
 * a hash of household and email, so no table holds an email. KV holds, per feed secret, whose it is,
 * sealed under the secret itself. (Records made before the scale-out are in KV and move to D1 when
 * first read.)
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

/** The minute slot (0..59) the person is checked in; migrations/0002 computes the same in SQL. */
export const shardOf = (pid: string): number => (pid.charCodeAt(0) * 64 + pid.charCodeAt(1)) % 60;

/** A hash of the household, to check its members together. */
export const householdKey = (household: string): Promise<string> => sha256(`household\u0000${household}`);

/** The record from its sealed text (a D1 row's `record`), or from KV where it was before, moved to D1. */
export async function openPerson(env: Env, pid: string, sealed: string | null | undefined): Promise<PersonRecord | null> {
  if (sealed) return unseal<PersonRecord>(env.SEAL_KEY, personKey(pid), sealed);
  const legacy = await env.TOKENS.get(personKey(pid));
  if (!legacy) return null;
  const record = await unseal<PersonRecord>(env.SEAL_KEY, personKey(pid), legacy);
  if (record) {
    await upsertPersonRow(env, pid, { record: legacy, hh: await householdKey(record.household) }, Date.now());
    await env.TOKENS.delete(personKey(pid));
  }
  return record;
}

export async function loadPerson(env: Env, pid: string): Promise<PersonRecord | null> {
  const row = await env.DB.prepare('SELECT record FROM people WHERE pid = ?').bind(pid).first<{ record: string | null }>();
  return openPerson(env, pid, row?.record);
}

export async function savePerson(env: Env, pid: string, record: PersonRecord): Promise<void> {
  await upsertPersonRow(env, pid, { record: await seal(env.SEAL_KEY, personKey(pid), record), hh: await householdKey(record.household) }, Date.now());
}

export async function deletePerson(env: Env, pid: string): Promise<void> {
  await env.DB.prepare('UPDATE people SET record = NULL WHERE pid = ?').bind(pid).run();
  await env.TOKENS.delete(personKey(pid));
}

/** A feed secret's id: its KV record's key and its precomputed feed's row. */
export const feedId = (secret: string): Promise<string> => sha256(`feed\u0000${secret}`);

const feedKey = async (secret: string) => `feed:${await feedId(secret)}`;

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
  record: string | null;
  shard: number;
  hh: string | null;
  work: number;
  queued_at: number | null;
  lease_until: number | null;
  backoff_until: number | null;
  backoff: number;
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

export async function upsertPersonRow(env: Env, pid: string, fields: Partial<Omit<PersonRow, 'pid' | 'created_at' | 'shard'>>, now: number): Promise<void> {
  const cols = Object.keys(fields);
  const values = Object.values(fields);
  const insertCols = ['pid', 'created_at', 'shard', ...cols];
  const placeholders = insertCols.map(() => '?').join(', ');
  const updates = cols.map((c) => `${c} = excluded.${c}`).join(', ');
  await env.DB.prepare(`INSERT INTO people (${insertCols.join(', ')}) VALUES (${placeholders}) ON CONFLICT(pid) DO ${updates ? `UPDATE SET ${updates}` : 'NOTHING'}`)
    .bind(pid, now, shardOf(pid), ...values)
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

// ---- The precomputed feed ----

export interface FeedRow {
  id: string;
  pid: string;
  signal: string;
  etag: string;
  body: string;
  built_at: number;
  stale: number;
}

/** The feed for `secret`, sealed so only the URL's secret opens it; any other feed of the person goes. */
export async function putFeed(env: Env, pid: string, secret: string, { signal, etag, body, now }: { signal: string; etag: string; body: string; now: number }): Promise<void> {
  const id = await feedId(secret);
  const sealed = await seal(env.SEAL_KEY, `ics:${secret}`, body);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM feeds WHERE pid = ? AND id != ?').bind(pid, id),
    env.DB.prepare('INSERT INTO feeds (id, pid, signal, etag, body, built_at, stale) VALUES (?, ?, ?, ?, ?, ?, 0) ON CONFLICT(id) DO UPDATE SET signal = excluded.signal, etag = excluded.etag, body = excluded.body, built_at = excluded.built_at, stale = 0').bind(id, pid, signal, etag, sealed, now),
  ]);
}

export async function openFeedBody(env: Env, secret: string, sealed: string): Promise<string | null> {
  return unseal<string>(env.SEAL_KEY, `ics:${secret}`, sealed);
}

/** A rotated feed keeps its calendar: the body sealed again for the new secret, no rebuild. */
export async function moveFeed(env: Env, pid: string, from: string, to: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT signal, etag, body, built_at FROM feeds WHERE id = ?').bind(await feedId(from)).first<Pick<FeedRow, 'signal' | 'etag' | 'body' | 'built_at'>>();
  const body = row ? await openFeedBody(env, from, row.body) : null;
  if (!row || body === null) {
    await env.DB.prepare('DELETE FROM feeds WHERE pid = ?').bind(pid).run();
    return false;
  }
  await putFeed(env, pid, to, { signal: row.signal, etag: row.etag, body, now: row.built_at });
  return true;
}
