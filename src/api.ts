import { exchangeRefreshToken, FirebaseAuthError, verifyIdToken } from '@huishouden/pwa-kit/firebase-auth-rest';
import { FirestoreError, FirestoreRest } from '@huishouden/pwa-kit/firestore-rest';
import { isLang, type Lang } from '@huishouden/pwa-kit/i18n';
import { isTimeZone } from '@huishouden/pwa-kit/local-clock';
import { householdTimeZone, toHome } from '@huishouden/pwa-kit/home';
import type { Env, Fetch } from './env';
import { feedUrl } from './feed';
import { log } from './log';
import { authOptions, overQuota, roleOf } from './person';
import { Calendar, CalendarApiError } from './google/api';
import { accessToken, CALENDAR_SCOPE, exchangeCode, GoogleAuthError, revokeGoogle } from './google/oauth';
import { deletePerson, deletePersonRows, loadPerson, moveFeed, newFeed, personId, personRow, revokeFeed, savePerson, upsertPersonRow, type PersonRecord } from './store';
import { lastChecked } from './tick';
import { FEED, markWork, SYNC } from './work';
import { answerReview, checkNow, connectInbox, disconnectInbox, MailHttpError, mailStatus, reviewList, undoImport } from './mail/api';

/**
 * What the portal's Calendar page calls, as the signed-in person (their Firebase ID token in
 * `Authorization`). CORS allows only the suite's site. Every answer is about the caller only.
 *
 * - `GET  /api/status?household=`: the feed's URL, and Google's state (account, last sync, errors).
 * - `POST /api/feed`: set up the feed (or refresh what it acts with). Body: household, the person's
 *   Firebase refresh token, language, time zone.
 * - `POST /api/feed/rotate`: a new secret URL; the old one stops working.
 * - `POST /api/feed/revoke`: no feed.
 * - `POST /api/google/connect`: Google's one-time code from the portal's popup; creates the
 *   "Huishouden" calendar and queues its first sync.
 * - `POST /api/google/sync`: sync now (queued: it runs within seconds, never in the request).
 *
 * No call here builds a feed or writes to Google: those are queued as work (src/work.ts), each in
 * its own invocation, so no request needs more than a few milliseconds of CPU.
 * - `POST /api/google/disconnect`: stop syncing; `deleteCalendar: true` also deletes the calendar.
 * - `/api/mail/*`: Spending's alert inboxes (src/mail/api.ts), from Spending's settings.
 */

export const GOOGLE_COLOUR = '#2d6a4f';

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** For the log only: what Google or Firebase said (an error name, never a token or an email). */
    readonly detail?: string,
  ) {
    super(code);
  }
}

/** A failure's cause for the log: the error's kind and the service's own error name or status. No values. */
function causeOf(e: unknown): Record<string, string | number> {
  if (e instanceof CalendarApiError) return { error: 'calendar', googleStatus: e.status, reason: e.message.replace(/^\[\d+\] /, '').slice(0, 80) };
  if (e instanceof GoogleAuthError) return { error: `google-${e.kind}`, reason: e.message.slice(0, 80) };
  if (e instanceof FirebaseAuthError) return { error: `firebase-${e.kind}` };
  if (e instanceof FirestoreError) return { error: 'firestore', reason: e.code };
  return { error: e instanceof Error ? e.name : typeof e };
}

function cors(env: Env, request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = env.ALLOWED_ORIGINS.split(/\s+/).filter(Boolean);
  if (!allowed.includes(origin)) return {};
  return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600', Vary: 'Origin' };
}

const json = (status: number, body: unknown, headers: Record<string, string>) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

interface Caller {
  uid: string;
  email: string;
  household: string;
  pid: string;
  idToken: string;
  /** Their role in the household (admin, member, helper, kid), from the household document read here. */
  role: string;
  /** The household's home zone, when its home has one. */
  homeZone?: string;
}

const HOUSEHOLD = /^[A-Za-z0-9_-]{1,128}$/;

/** 503, saying which: `firestore-quota` (back after the daily reset; retrying sooner only uses requests) or `unavailable`. */
const unavailable = (e: unknown) => new HttpError(503, overQuota(e) ? 'firestore-quota' : 'unavailable');

async function caller(env: Env, request: Request, household: string | null, fetchImpl: Fetch | undefined, firestoreUrl?: string): Promise<Caller> {
  const idToken = /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '')?.[1];
  if (!idToken) throw new HttpError(401, 'sign-in');
  if (!household || !HOUSEHOLD.test(household)) throw new HttpError(400, 'household');
  let who;
  try {
    who = await verifyIdToken(authOptions(env, fetchImpl), idToken);
  } catch (e) {
    if (e instanceof FirebaseAuthError && e.kind === 'unavailable') throw new HttpError(503, 'unavailable');
    throw new HttpError(401, 'sign-in');
  }
  // A member reads their household; anyone else is refused by the rules.
  const db = new FirestoreRest({ projectId: env.FIREBASE_PROJECT_ID, token: async () => idToken, ...(fetchImpl ? { fetch: fetchImpl } : {}), ...((firestoreUrl ?? env.FIRESTORE_URL) ? { baseUrl: firestoreUrl ?? env.FIRESTORE_URL } : {}) });
  // Only the rules' refusal (or no such household) means "not a member". Anything else, such as
  // Firestore's daily quota (429 RESOURCE_EXHAUSTED) or an outage, is the service being unavailable.
  const doc = await db.get(`households/${household}`).catch((e: unknown) => {
    if (e instanceof FirestoreError && (e.code === 'permission-denied' || e.code === 'not-found')) return null;
    throw unavailable(e);
  });
  const members = Array.isArray(doc?.data.members) ? (doc!.data.members as unknown[]) : [];
  if (!members.includes(who.email)) throw new HttpError(403, 'not-member');
  const homeZone = toHome(doc!.data.home)?.timeZone;
  return { ...who, household, pid: await personId(household, who.email), idToken, role: roleOf(doc!.data, who.email), ...(homeZone ? { homeZone } : {}) };
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const b = (await request.json()) as unknown;
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, 'body');
  }
}

/** The person's record, made or refreshed from what the portal sent: their refresh token (checked to be theirs), language and zone. */
async function personFrom(env: Env, who: Caller, b: Record<string, unknown>, fetchImpl?: Fetch): Promise<PersonRecord> {
  const existing = await loadPerson(env, who.pid);
  const lang: Lang = isLang(b.lang) ? b.lang : (existing?.lang ?? 'en');
  const timeZone = typeof b.timeZone === 'string' && isTimeZone(b.timeZone) ? b.timeZone : (existing?.timeZone ?? 'UTC');
  let refreshToken = existing?.refreshToken;
  if (typeof b.refreshToken === 'string' && b.refreshToken.length >= 20 && b.refreshToken.length <= 4096) {
    let checked;
    try {
      checked = await exchangeRefreshToken(authOptions(env, fetchImpl), b.refreshToken);
    } catch (e) {
      throw new HttpError(400, 'refresh-token', e instanceof FirebaseAuthError ? `firebase-${e.kind}: ${e.message.slice(0, 60)}` : 'error');
    }
    if (checked.uid !== who.uid) throw new HttpError(400, 'refresh-token');
    refreshToken = b.refreshToken;
  }
  if (!refreshToken) throw new HttpError(400, 'refresh-token');
  return { ...(existing ?? {}), household: who.household, email: who.email, uid: who.uid, refreshToken, lang, timeZone, signedOut: false } as PersonRecord;
}

function origin(request: Request): string {
  return new URL(request.url).origin;
}

async function status(env: Env, request: Request, who: Caller) {
  const record = await loadPerson(env, who.pid);
  const row = await personRow(env, who.pid);
  const base = origin(request);
  // Quiet checks write nothing per person: the last check is their slot's (src/tick.ts), unless
  // their own run since then says otherwise.
  const checked = row && record?.google && !row.last_error ? await lastChecked(env, row.shard, true) : 0;
  const lastOk = Math.max(row?.last_ok ?? 0, checked) || null;
  const lastSync = Math.max(row?.last_sync ?? 0, checked) || null;
  const feed = record?.feed ? feedUrl(base, record.feed.secret) : null;
  return {
    feed: feed ? { url: feed, webcal: feed.replace(/^https?:/, 'webcal:'), createdAt: record!.feed!.createdAt } : null,
    signedOut: record?.signedOut === true,
    googleAvailable: !!env.GOOGLE_CLIENT_SECRET,
    google: record?.google
      ? {
          account: record.google.account,
          connectedAt: record.google.connectedAt,
          lastSync,
          lastOk,
          error: row?.last_error ?? null,
          notice: row?.notice ?? null,
          counts: row?.counts ? (JSON.parse(row.counts) as Record<string, number>) : null,
        }
      : null,
    lastError: !record?.google && row?.last_error ? row.last_error : null,
  };
}

export async function handleApi(env: Env, request: Request, ctx: ExecutionContext | undefined, deps: { fetch?: Fetch; now?: number; firestoreUrl?: string } = {}): Promise<Response> {
  const headers = cors(env, request);
  if (request.method === 'OPTIONS') return new Response(null, { status: headers['Access-Control-Allow-Origin'] ? 204 : 403, headers });
  const url = new URL(request.url);
  const now = deps.now ?? Date.now();
  const fetchImpl = deps.fetch;
  try {
    const b = request.method === 'POST' ? await body(request) : {};
    const household = request.method === 'GET' ? url.searchParams.get('household') : typeof b.household === 'string' ? b.household : null;
    const who = await caller(env, request, household, fetchImpl, deps.firestoreUrl);
    const route = `${request.method} ${url.pathname}`;
    switch (route) {
      case 'GET /api/status':
        return json(200, await status(env, request, who), headers);
      case 'POST /api/feed': {
        const record = await personFrom(env, who, b, fetchImpl);
        if (!record.feed) record.feed = { secret: await newFeed(env, who.pid), createdAt: now };
        await savePerson(env, who.pid, record);
        await upsertPersonRow(env, who.pid, { feed: 1 }, now);
        // The link works the moment the portal shows it: the feed is built now, in its own invocation
        // (env.SELF), never in this request's. Without one, queued.
        await buildNow(env, who.pid, now);
        log('api', { route: 'feed', ok: true });
        return json(200, await status(env, request, who), headers);
      }
      case 'POST /api/feed/rotate': {
        const record = await personFrom(env, who, b, fetchImpl);
        const old = record.feed?.secret;
        if (old) await revokeFeed(env, old);
        record.feed = { secret: await newFeed(env, who.pid), createdAt: now };
        await savePerson(env, who.pid, record);
        await upsertPersonRow(env, who.pid, { feed: 1 }, now);
        // The new URL serves the same calendar at once (sealed again for it); the old one stops.
        if (!old || !(await moveFeed(env, who.pid, old, record.feed.secret))) await buildNow(env, who.pid, now);
        log('api', { route: 'rotate', ok: true });
        return json(200, await status(env, request, who), headers);
      }
      case 'POST /api/feed/revoke': {
        const record = await loadPerson(env, who.pid);
        if (record?.feed) await revokeFeed(env, record.feed.secret);
        if (record?.google) {
          await savePerson(env, who.pid, { ...record, feed: undefined });
          await upsertPersonRow(env, who.pid, { feed: 0 }, now);
          await env.DB.prepare('DELETE FROM feeds WHERE pid = ?').bind(who.pid).run();
        } else {
          await deletePerson(env, who.pid);
          await deletePersonRows(env, who.pid);
        }
        log('api', { route: 'revoke', ok: true });
        return json(200, await status(env, request, who), headers);
      }
      case 'POST /api/google/connect': {
        if (typeof b.code !== 'string' || b.code.length > 2048) throw new HttpError(400, 'code');
        const record = await personFrom(env, who, b, fetchImpl);
        let granted;
        try {
          granted = await exchangeCode(env, b.code, fetchImpl, now);
        } catch (e) {
          if (e instanceof GoogleAuthError) throw new HttpError(e.kind === 'config' ? 501 : e.kind === 'unavailable' ? 503 : 400, `google-${e.kind}`, e.message.slice(0, 80));
          throw e;
        }
        const calendar = new Calendar(granted.accessToken, fetchImpl);
        // Connecting again keeps the calendar it made before, when it is still there.
        let calendarId = record.google?.calendarId;
        if (!calendarId || !(await calendar.calendarExists(calendarId).catch(() => false))) {
          calendarId = await calendar.createCalendar(env.CALENDAR_NAME ?? 'Huishouden', descriptionFor(record.lang), householdTimeZone({ timeZone: who.homeZone }, record.timeZone));
          await calendar.colour(calendarId, GOOGLE_COLOUR);
          await env.DB.prepare('DELETE FROM events WHERE pid = ?').bind(who.pid).run();
          await upsertPersonRow(env, who.pid, { sync_token: null, signal: null, full_at: null }, now);
        }
        if (record.google && record.google.refreshToken !== granted.refreshToken) await revokeGoogle(record.google.refreshToken, fetchImpl);
        record.google = { refreshToken: granted.refreshToken, calendarId, account: granted.account, scope: CALENDAR_SCOPE, connectedAt: now };
        await savePerson(env, who.pid, record);
        await upsertPersonRow(env, who.pid, { google: 1, last_error: null, notice: null }, now);
        await markWork(env, who.pid, SYNC, now);
        log('api', { route: 'google-connect', ok: true });
        return json(200, await status(env, request, who), headers);
      }
      case 'POST /api/google/sync': {
        const record = await loadPerson(env, who.pid);
        if (!record?.google) throw new HttpError(409, 'not-connected');
        await markWork(env, who.pid, SYNC, now);
        return json(200, await status(env, request, who), headers);
      }
      case 'POST /api/google/disconnect': {
        const record = await loadPerson(env, who.pid);
        if (record?.google) {
          if (b.deleteCalendar === true) {
            try {
              const calendar = new Calendar(await accessToken(env, record.google.refreshToken, fetchImpl, now), fetchImpl);
              await calendar.deleteCalendar(record.google.calendarId);
            } catch {
              // Access already removed in Google: there is nothing more the Worker can delete.
            }
          }
          await revokeGoogle(record.google.refreshToken, fetchImpl);
          const rest = { ...record, google: undefined };
          if (rest.feed) await savePerson(env, who.pid, rest);
          else await deletePerson(env, who.pid);
        }
        await env.DB.prepare('DELETE FROM events WHERE pid = ?').bind(who.pid).run();
        if (record?.feed) await upsertPersonRow(env, who.pid, { google: 0, sync_token: null, signal: null, full_at: null, last_error: null, notice: null, counts: null }, now);
        else await deletePersonRows(env, who.pid);
        log('api', { route: 'google-disconnect', ok: true, deleted: b.deleteCalendar === true });
        return json(200, await status(env, request, who), headers);
      }
      case 'GET /api/mail/status':
        if (who.role !== 'admin' && who.role !== 'member') throw new HttpError(403, 'not-allowed');
        return json(200, await mailStatus(env, who), headers);
      case 'POST /api/mail/connect':
        return json(200, await connectInbox(env, who, b, { ...deps, now }), headers);
      case 'POST /api/mail/check':
        return json(200, await checkNow(env, who, { ...deps, now }), headers);
      case 'POST /api/mail/disconnect':
        return json(200, await disconnectInbox(env, who, b, { ...deps, now }), headers);
      case 'GET /api/mail/review':
        return json(200, await reviewList(env, who, url.searchParams.get('inbox')), headers);
      case 'POST /api/mail/review':
        return json(200, await answerReview(env, who, b, { ...deps, now }), headers);
      case 'POST /api/mail/undo':
        return json(200, await undoImport(env, who, b, { ...deps, now }), headers);
      case 'POST /api/notice/clear': {
        await upsertPersonRow(env, who.pid, { notice: null }, now);
        return json(200, await status(env, request, who), headers);
      }
      default:
        throw new HttpError(404, 'route');
    }
  } catch (e) {
    if (e instanceof MailHttpError) e = new HttpError(e.status, e.code, e.detail);
    if (e instanceof HttpError) {
      log('api', { route: url.pathname, ok: false, status: e.status, code: e.code, ...(e.detail ? { detail: e.detail } : {}) });
      return json(e.status, { error: e.code }, headers);
    }
    if (overQuota(e)) {
      log('api', { route: url.pathname, ok: false, status: 503, code: 'firestore-quota' });
      return json(503, { error: 'firestore-quota' }, { ...headers, 'Retry-After': '3600' });
    }
    log('api', { route: url.pathname, ok: false, status: 500, ...causeOf(e) });
    return json(500, { error: 'server' }, headers);
  }
}

/** The person's feed built before the answer, in another invocation of this Worker; queued when there is none. */
async function buildNow(env: Env, pid: string, now: number): Promise<void> {
  if (!env.SELF) {
    await markWork(env, pid, FEED, now);
    return;
  }
  await markWork(env, pid, FEED, now, { queue: false });
  const outcome = await env.SELF.work(pid).catch(() => null);
  // Busy, failed or backing off: the queue takes it from here.
  if (!outcome || !('done' in outcome)) await markWork(env, pid, 0, now);
}

const DESCRIPTIONS: Record<Lang, string> = {
  en: 'From Huishouden: appointments, regular events and things to do at home. Changes you make here go back to Huishouden.',
  es: 'De Huishouden: citas, eventos habituales y cosas por hacer en casa. Los cambios que hagas aquí vuelven a Huishouden.',
  nl: 'Uit Huishouden: afspraken, vaste gebeurtenissen en dingen die thuis moeten gebeuren. Wat je hier wijzigt, gaat terug naar Huishouden.',
};

const descriptionFor = (lang: Lang) => DESCRIPTIONS[lang] ?? DESCRIPTIONS.en;
