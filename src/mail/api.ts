import { exchangeRefreshToken, FirebaseAuthError } from '@huishouden/pwa-kit/firebase-auth-rest';
import { FirestoreError, FirestoreRest } from '@huishouden/pwa-kit/firestore-rest';
import { isTimeZone } from '@huishouden/pwa-kit/local-clock';
import { ALERT_INBOXES, ALERT_LOOKBACK_DAYS } from '@huishouden/pwa-kit/spending-core';
import type { Env, Fetch } from '../env';
import { log } from '../log';
import { authOptions } from '../person';
import { householdKey } from '../store';
import { exchangeCode, GMAIL_SCOPE, GoogleAuthError, revokeGoogle } from '../google/oauth';
import { Gmail, GmailApiError } from './gmail';
import { actingAs, inboxDoc } from './inbox';
import { MAIL_EVERY_MIN } from './check';
import { deleteInbox, householdInboxes, inboxIdOf, inboxRow, lastMailTick, openRecord, putInbox, STOPPED, type InboxRecord } from './store';
import { markMailWork } from './work';

/**
 * Spending's calls about alert inboxes, as the signed-in member (admins and members only: helpers
 * and kids never see Spending):
 *
 * - `GET  /api/mail/status?household=`: each inbox: address, who connected it, last checked, last
 *   alerts found, an error (`revoked`: Reconnect), whether a check is under way.
 * - `POST /api/mail/connect`: Google's one-time code for `gmail.readonly` from the app's popup (any
 *   Google account, from the account chooser), the member's Firebase refresh token and time zone.
 *   Saves the inbox and starts its first check, which looks back to the household's newest
 *   transaction (at most ALERT_LOOKBACK_DAYS).
 * - `POST /api/mail/check`: check every inbox now, with the household's latest cards and rules.
 * - `POST /api/mail/disconnect`: `inbox`; the member who connected it or an admin. Google's grant
 *   is revoked and everything kept for it deleted.
 */

export interface MailCaller {
  uid: string;
  email: string;
  household: string;
  idToken: string;
  role: string;
}

export class MailHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(code);
  }
}

export interface MailDeps {
  fetch?: Fetch;
  now?: number;
  firestoreUrl?: string;
}

export interface InboxStatus {
  id: string;
  address: string;
  by: string;
  mine: boolean;
  connectedAt: number;
  lastChecked: number | null;
  lastAlertAt: number | null;
  lastAdded: number | null;
  error: string | null;
  checking: boolean;
}

export interface MailStatus {
  /** Whether this server can connect inboxes (its Google client secret is set). */
  available: boolean;
  inboxes: InboxStatus[];
  /** The latest check of any inbox: the Overview's "Updated ... ago". */
  lastChecked: number | null;
}

const DAY = 86_400_000;

export async function mailStatus(env: Env, who: MailCaller): Promise<MailStatus> {
  const rows = await householdInboxes(env, who.household);
  const inboxes: InboxStatus[] = [];
  for (const row of rows) {
    const record = await openRecord(env, row);
    if (!record) continue;
    const stopped = !!row.error && STOPPED.includes(row.error);
    const tick = stopped ? 0 : await lastMailTick(env, row.shard, MAIL_EVERY_MIN);
    const checked = Math.max(row.checked_at ?? 0, tick >= row.created_at ? tick : 0);
    inboxes.push({
      id: row.id,
      address: record.address,
      by: record.email,
      mine: record.email === who.email,
      connectedAt: record.connectedAt,
      lastChecked: checked || null,
      lastAlertAt: row.found_at,
      lastAdded: row.added,
      error: row.error,
      checking: row.pending !== 0 && !stopped,
    });
  }
  const checks = inboxes.map((i) => i.lastChecked ?? 0).filter(Boolean);
  return { available: !!env.GOOGLE_CLIENT_SECRET, inboxes, lastChecked: checks.length ? Math.max(...checks) : null };
}

const staffOnly = (who: MailCaller) => {
  if (who.role !== 'admin' && who.role !== 'member') throw new MailHttpError(403, 'not-allowed');
};

/** Where the first check starts: the household's newest transaction (less two days), at most ALERT_LOOKBACK_DAYS back. */
async function backfillFrom(person: ReturnType<typeof actingAs>, now: number): Promise<number> {
  const floor = now - ALERT_LOOKBACK_DAYS * DAY;
  const latest = await person.db.query(person.base, 'spendingTransactions', { orderBy: [{ field: 'date', direction: 'DESCENDING' }], limit: 1 }).catch(() => []);
  const day = latest[0] ? Date.parse(String(latest[0].data.date ?? '')) : NaN;
  return Number.isFinite(day) ? Math.min(now, Math.max(floor, day - 2 * DAY)) : floor;
}

export async function connectInbox(env: Env, who: MailCaller, b: Record<string, unknown>, deps: MailDeps): Promise<MailStatus> {
  staffOnly(who);
  const now = deps.now ?? Date.now();
  if (typeof b.code !== 'string' || !b.code || b.code.length > 2048) throw new MailHttpError(400, 'code');
  if (typeof b.refreshToken !== 'string' || b.refreshToken.length < 20 || b.refreshToken.length > 4096) throw new MailHttpError(400, 'refresh-token');
  let checked;
  try {
    checked = await exchangeRefreshToken(authOptions(env, deps.fetch), b.refreshToken);
  } catch (e) {
    throw new MailHttpError(400, 'refresh-token', e instanceof FirebaseAuthError ? `firebase-${e.kind}` : 'error');
  }
  if (checked.uid !== who.uid) throw new MailHttpError(400, 'refresh-token');
  const timeZone = typeof b.timeZone === 'string' && isTimeZone(b.timeZone) ? b.timeZone : 'UTC';

  let granted;
  try {
    granted = await exchangeCode(env, b.code, deps.fetch, now, GMAIL_SCOPE);
  } catch (e) {
    if (e instanceof GoogleAuthError) throw new MailHttpError(e.kind === 'config' ? 501 : e.kind === 'unavailable' ? 503 : 400, `google-${e.kind}`, e.message.slice(0, 80));
    throw e;
  }
  const fetchImpl: Fetch = deps.fetch ?? ((url, init) => fetch(url, init));
  let profile;
  try {
    profile = await new Gmail(granted.accessToken, fetchImpl).profile();
  } catch (e) {
    await revokeGoogle(granted.refreshToken, deps.fetch);
    throw new MailHttpError(e instanceof GmailApiError && e.status === 403 ? 400 : 503, e instanceof GmailApiError && e.status === 403 ? 'google-denied' : 'unavailable', e instanceof GmailApiError ? `gmail-${e.status}` : 'error');
  }
  const address = profile.address || granted.account;
  if (!address) throw new MailHttpError(400, 'google-denied', 'no address');

  const id = await inboxIdOf(who.household, address);
  const record: InboxRecord = { household: who.household, email: who.email, uid: who.uid, refreshToken: b.refreshToken, google: granted.refreshToken, address, timeZone, connectedAt: now };
  const person = actingAs(env, record, deps.fetch, deps.firestoreUrl);
  try {
    await person.db.commit([{ path: `${person.base}/${ALERT_INBOXES}/${id}`, set: inboxDoc(record, now) }]);
  } catch (e) {
    await revokeGoogle(granted.refreshToken, deps.fetch);
    if (e instanceof FirestoreError && e.code === 'permission-denied') throw new MailHttpError(403, 'not-allowed');
    throw e;
  }
  const before = await inboxRow(env, id);
  const previous = before ? await openRecord(env, before) : null;
  if (previous && previous.google !== granted.refreshToken) await revokeGoogle(previous.google, deps.fetch);
  await putInbox(env, id, record, { since: await backfillFrom(person, now), historyId: profile.historyId || null, now });
  await markMailWork(env, id, now);
  log('api', { route: 'mail-connect', ok: true, again: !!before });
  return mailStatus(env, who);
}

export async function checkNow(env: Env, who: MailCaller, deps: MailDeps): Promise<MailStatus> {
  staffOnly(who);
  const now = deps.now ?? Date.now();
  let queued = 0;
  for (const row of await householdInboxes(env, who.household)) {
    if (row.error && STOPPED.includes(row.error)) continue;
    if (await markMailWork(env, row.id, now, { refreshConfig: true })) queued++;
  }
  log('api', { route: 'mail-check', ok: true, queued });
  return mailStatus(env, who);
}

export async function disconnectInbox(env: Env, who: MailCaller, b: Record<string, unknown>, deps: MailDeps): Promise<MailStatus> {
  staffOnly(who);
  if (typeof b.inbox !== 'string' || !/^ib-[A-Za-z0-9_-]{1,61}$/.test(b.inbox)) throw new MailHttpError(400, 'inbox');
  const row = await inboxRow(env, b.inbox);
  const record = row && row.hh === (await householdKey(who.household)) ? await openRecord(env, row) : null;
  if (record && record.email !== who.email && who.role !== 'admin') throw new MailHttpError(403, 'not-allowed');
  // The document first, as the caller: the rules let only its member or an admin remove it.
  const db = new FirestoreRest({
    projectId: env.FIREBASE_PROJECT_ID,
    token: async () => who.idToken,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...((deps.firestoreUrl ?? env.FIRESTORE_URL) ? { baseUrl: deps.firestoreUrl ?? env.FIRESTORE_URL } : {}),
  });
  try {
    await db.commit([{ path: `households/${who.household}/${ALERT_INBOXES}/${b.inbox}`, delete: true }]);
  } catch (e) {
    if (e instanceof FirestoreError && e.code === 'permission-denied') throw new MailHttpError(403, 'not-allowed');
    throw e;
  }
  if (record) {
    await revokeGoogle(record.google, deps.fetch);
    await deleteInbox(env, b.inbox);
  }
  log('api', { route: 'mail-disconnect', ok: true });
  return mailStatus(env, who);
}
