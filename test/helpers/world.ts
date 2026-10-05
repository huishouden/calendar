import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeFields, encodeFields } from '@huishouden/pwa-kit/firestore-rest';
import type { Env } from '../../src/env';
import { forgetTokens } from '../../src/person';
import { forgetAccess } from '../../src/google/oauth';
import { checkPeople } from '../../src/check';
import { runWork, type WorkMessage } from '../../src/work';
import { FakeGoogle } from './google';
import { FakeGmail } from './gmail';
import { checkInboxes } from '../../src/mail/check';
import { runMailWork } from '../../src/mail/work';
import { memoryD1, memoryKV } from './d1';
import fixture from '../fixtures/household.json';

/** A refresh token the fake Firebase Auth signs in as `email` with. */
export const refreshFor = (email: string) => `rt:${email}#refresh-token`;

/**
 * A test world: the Worker's env with in-memory D1 and KV, Google faked, Firebase Auth faked
 * (a refresh token "rt:<email>" signs in as that email), and Firestore the emulator with the
 * household's real rules, so every read and write the Worker makes as a person meets them.
 */

export const PROJECT = 'demo-huishouden-calendar';
const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
export const FIRESTORE = `http://${host}/v1`;
const ROOT = `projects/${PROJECT}/databases/(default)/documents`;

/** The household's rules: a sibling checkout of huishouden/rules, or RULES_PATH (CI fetches main's). */
export function rulesText(): string {
  const candidates = [process.env.RULES_PATH, join(import.meta.dir, '..', '..', '..', 'rules', 'firestore.rules'), join(import.meta.dir, '..', '.rules', 'firestore.rules')].filter(Boolean) as string[];
  const path = candidates.find((p) => existsSync(p));
  if (!path) throw new Error('No firestore.rules: set RULES_PATH or check out huishouden/rules next to this repo.');
  return readFileSync(path, 'utf8');
}

const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** An unsigned ID token the emulator accepts, for `email`. */
export function idTokenFor(email: string, now = Math.floor(Date.now() / 1000)): string {
  const uid = `u-${email.split('@')[0]}`;
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, iat: now, exp: now + 3600, auth_time: now, sub: uid, user_id: uid, email, email_verified: true, firebase: { sign_in_provider: 'google.com', identities: {} } })}.`;
}

async function owner(method: string, url: string, body?: unknown): Promise<Response> {
  return fetch(url, { method, headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
}

let rulesLoaded = false;

export async function resetFirestore(): Promise<void> {
  if (!rulesLoaded) {
    const res = await fetch(`http://${host}/emulator/v1/projects/${PROJECT}:securityRules`, { method: 'PUT', body: JSON.stringify({ rules: { files: [{ content: rulesText() }] } }) });
    if (!res.ok) throw new Error(`Loading rules failed: ${res.status} ${await res.text()}`);
    rulesLoaded = true;
  }
  await fetch(`http://${host}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
}

/** ISO strings become ms; `$series:<day>` and `$binsEdit` become the fixture's series and edits. */
function materialize(v: unknown): unknown {
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/.test(v)) return Date.parse(v);
    if (v.startsWith('$series:')) return { ...fixture.series, original: v.slice(8) };
    if (v === '$binsEdit') return fixture.binsEdit;
    return v;
  }
  if (Array.isArray(v)) return v.map(materialize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, materialize(x)]));
  return v;
}

export async function seed(docs: Record<string, unknown> = fixture.docs): Promise<void> {
  const writes = Object.entries(docs).map(([path, data]) => ({ update: { name: `${ROOT}/${path}`, fields: encodeFields(materialize(data) as Record<string, unknown>) } }));
  const res = await owner('POST', `${FIRESTORE}/${ROOT}:commit`, { writes });
  if (!res.ok) throw new Error(`Seeding failed: ${res.status} ${await res.text()}`);
}

export async function readDoc(path: string): Promise<Record<string, unknown> | null> {
  const res = await owner('GET', `${FIRESTORE}/${ROOT}/${path}`);
  if (res.status === 404) return null;
  const body = (await res.json()) as { fields?: Record<string, never> };
  return decodeFields(body.fields);
}

export async function listDocs(path: string): Promise<{ id: string; data: Record<string, unknown> }[]> {
  const res = await owner('GET', `${FIRESTORE}/${ROOT}/${path}?pageSize=300`);
  const body = (await res.json()) as { documents?: { name: string; fields?: Record<string, never> }[] };
  return (body.documents ?? []).map((d) => ({ id: d.name.split('/').pop()!, data: decodeFields(d.fields) }));
}

export async function writeDoc(path: string, data: Record<string, unknown>): Promise<void> {
  await seed({ [path]: data });
}

export async function deleteDoc(path: string): Promise<void> {
  await owner('DELETE', `${FIRESTORE}/${ROOT}/${path}`);
}

export interface World {
  env: Env & { TOKENS: KVNamespace & { map: Map<string, string> } };
  /** Messages on the work queue (a person's, or an alert inbox's), oldest first; `drain` runs them. */
  queue: (WorkMessage | { inbox: string })[];
  /** When set, the queue refuses messages (the free plan's daily operations used up). */
  queueFull: { on: boolean };
  google: FakeGoogle;
  gmail: FakeGmail;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  clock: { now: number };
  /** Requests that left for Firebase Auth. */
  authCalls: string[];
}

export const NOW = Date.parse('2031-10-01T12:00:00Z');

export function world(): World {
  forgetTokens();
  forgetAccess();
  const clock = { now: NOW };
  const google = new FakeGoogle(() => clock.now);
  const gmail = new FakeGmail();
  const authCalls: string[] = [];
  const sealKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  const env = {
    TOKENS: memoryKV(),
    DB: memoryD1(),
    FIREBASE_PROJECT_ID: PROJECT,
    FIREBASE_API_KEY: 'demo-key',
    GOOGLE_CLIENT_ID: 'demo-client.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'demo-secret',
    SEAL_KEY: sealKey,
    SITE_URL: 'https://site.example',
    GOOGLE_REDIRECT_URIS: 'https://site.example/my-calendar https://site.example/spending/',
    ALLOWED_ORIGINS: 'https://site.example',
    CALENDAR_NAME: 'Huishouden',
    FIRESTORE_URL: FIRESTORE,
  } as World['env'];
  const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const fromGoogle = (await gmail.handle(url, init)) ?? (await google.handle(url, init));
    if (fromGoogle) return fromGoogle;
    const u = new URL(url);
    if (u.hostname === 'securetoken.googleapis.com') {
      authCalls.push('token');
      const refresh = new URLSearchParams(String(init?.body)).get('refresh_token') ?? '';
      if (!refresh.startsWith('rt:') || refresh.startsWith('rt:revoked')) return Response.json({ error: { message: 'TOKEN_EXPIRED' } }, { status: 400 });
      return Response.json({ id_token: idTokenFor(refresh.slice(3).split('#')[0]), expires_in: '3600' });
    }
    if (u.hostname === 'identitytoolkit.googleapis.com') {
      authCalls.push('lookup');
      const token = (JSON.parse(String(init?.body)) as { idToken: string }).idToken;
      const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { user_id: string; email: string };
      return Response.json({ users: [{ localId: claims.user_id, email: claims.email, emailVerified: true }] });
    }
    return fetch(url, init);
  };
  const queue: (WorkMessage | { inbox: string })[] = [];
  const queueFull = { on: false };
  env.WORK = {
    send: async (m: WorkMessage | { inbox: string }) => {
      if (queueFull.on) throw new Error('Queue operations limit exceeded');
      queue.push(m);
    },
  } as unknown as Queue<WorkMessage>;
  // The Fanout entrypoint, called in place (Cloudflare runs each call as its own invocation).
  env.SELF = {
    check: (pids) => checkPeople(env, pids, { fetch: fakeFetch, now: clock.now }),
    work: (pid) => runWork(env, pid, { fetch: fakeFetch, now: clock.now, next: (p) => env.SELF!.work(p) }),
    mail: (ids) => checkInboxes(env, ids, { fetch: fakeFetch, now: clock.now, firestoreUrl: FIRESTORE }),
    mailWork: (id) => runMailWork(env, id, { fetch: fakeFetch, now: clock.now, firestoreUrl: FIRESTORE, next: (i) => env.SELF!.mailWork(i) }),
  };
  return { env, google, gmail, fetch: fakeFetch, clock, authCalls, queue, queueFull };
}

/** Runs the queue until it is empty, as the consumer does: one unit per message. Returns how many ran. */
export async function drain(w: World): Promise<number> {
  let n = 0;
  while (w.queue.length) {
    const m = w.queue.shift()!;
    n++;
    const outcome =
      'inbox' in m
        ? await runMailWork(w.env, m.inbox, { fetch: w.fetch, now: w.clock.now, firestoreUrl: FIRESTORE, next: (i) => w.env.SELF!.mailWork(i) })
        : await runWork(w.env, m.pid, { fetch: w.fetch, now: w.clock.now, next: (p) => w.env.SELF!.work(p) });
    if ('retryAfter' in outcome && n > 50) throw new Error('the queue keeps retrying');
  }
  return n;
}

/** Everyone checked now (as the cron's checks would, whatever their slot), then their work run. */
export async function refresh(w: World): Promise<void> {
  const { results } = await w.env.DB.prepare('SELECT pid FROM people').all<{ pid: string }>();
  await checkPeople(w.env, results.map((r) => r.pid), { fetch: w.fetch, now: w.clock.now });
  await drain(w);
}

/** A request to the Worker's API as `email`, from the site. */
export function apiRequest(path: string, email: string | null, body?: Record<string, unknown>, method = body ? 'POST' : 'GET'): Request {
  return new Request(`https://calendar.example${path}`, {
    method,
    headers: { Origin: 'https://site.example', 'Content-Type': 'application/json', ...(email ? { Authorization: `Bearer ${idTokenFor(email)}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

export const household = fixture.household;
export const TZ = fixture.timeZone;
