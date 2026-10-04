import { sha256 } from '../b64';
import type { Env, Fetch } from '../env';

/**
 * Google OAuth for the Calendar sync. The portal asks Google for a one-time code (Google Identity
 * Services' code client, the suite's own web client, popup mode); the Worker exchanges it here with
 * the client secret for a refresh token, which it keeps sealed (src/store.ts) and turns into access
 * tokens on each run.
 *
 * Scope: `calendar.app.created` only. It lets the app create secondary calendars and manage them
 * and their events, and nothing else: no other calendar in the account is visible to it.
 */

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** `revoked`: Google won't give tokens any more (access removed, password changed); `unavailable`: try later; `config`: no client secret. */
export class GoogleAuthError extends Error {
  constructor(
    readonly kind: 'revoked' | 'denied' | 'unavailable' | 'config',
    message: string,
  ) {
    super(message);
  }
}

interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenCall(fetchImpl: Fetch, body: Record<string, string>): Promise<TokenAnswer> {
  let res: Response;
  try {
    res = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  } catch {
    throw new GoogleAuthError('unavailable', 'Google unreachable');
  }
  const answer = (await res.json().catch(() => ({}))) as TokenAnswer;
  if (!res.ok || !answer.access_token) {
    // Google's own error name and description, for the log (never a token).
    const said = `${answer.error ?? res.status}${answer.error_description ? `: ${answer.error_description}` : ''}`.slice(0, 120);
    if (answer.error === 'invalid_grant') throw new GoogleAuthError('revoked', `Google access was removed (${said})`);
    if (res.status >= 400 && res.status < 500) throw new GoogleAuthError('denied', said);
    throw new GoogleAuthError('unavailable', `Google ${said}`);
  }
  return answer;
}

function claims(idToken: string | undefined): Record<string, unknown> {
  const part = idToken?.split('.')[1];
  if (!part) return {};
  try {
    return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='))) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface Granted {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  scope: string;
  /** The Google account's email, from the ID token Google sent with it. */
  account: string;
}

/** The code from the portal's popup, exchanged for tokens. `postmessage` is the popup flow's redirect. */
export async function exchangeCode(env: Env, code: string, fetchImpl: Fetch = fetch, now = Date.now()): Promise<Granted> {
  if (!env.GOOGLE_CLIENT_SECRET) throw new GoogleAuthError('config', 'Google Calendar sync is not set up on this server');
  const answer = await tokenCall(fetchImpl, { code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: 'postmessage', grant_type: 'authorization_code' });
  const scope = answer.scope ?? '';
  if (!scope.split(/\s+/).includes(CALENDAR_SCOPE)) throw new GoogleAuthError('denied', 'Calendar access was not allowed');
  if (!answer.refresh_token) throw new GoogleAuthError('denied', 'Google gave no lasting access; connect again');
  const id = claims(answer.id_token);
  return {
    refreshToken: answer.refresh_token,
    accessToken: answer.access_token!,
    expiresAt: now + (answer.expires_in ?? 3600) * 1000,
    scope,
    account: typeof id.email === 'string' ? id.email.toLowerCase() : '',
  };
}

const access = new Map<string, { token: string; expiresAt: number }>();

/** For tests: forget cached access tokens. */
export const forgetAccess = () => access.clear();

/** An access token for the refresh token: this isolate's while it lasts, otherwise a new one. */
export async function accessToken(env: Env, refreshToken: string, fetchImpl: Fetch = fetch, now = Date.now()): Promise<string> {
  const key = await sha256(refreshToken);
  const hit = access.get(key);
  if (hit && hit.expiresAt - 5 * 60_000 > now) return hit.token;
  if (!env.GOOGLE_CLIENT_SECRET) throw new GoogleAuthError('config', 'Google Calendar sync is not set up on this server');
  const answer = await tokenCall(fetchImpl, { refresh_token: refreshToken, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token' });
  if (access.size > 500) access.clear();
  access.set(key, { token: answer.access_token!, expiresAt: now + (answer.expires_in ?? 3600) * 1000 });
  return answer.access_token!;
}

/** Tells Google to forget the grant (disconnect). Failures are ignored: the token is dropped either way. */
export async function revokeGoogle(refreshToken: string, fetchImpl: Fetch = fetch): Promise<void> {
  await fetchImpl(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, { method: 'POST' }).catch(() => undefined);
  access.delete(await sha256(refreshToken));
}
