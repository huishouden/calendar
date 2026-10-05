import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import ICAL from 'ical.js';
import { icsProblems } from '@huishouden/pwa-kit/ics';
import { handleApi } from '../src/api';
import { personId } from '../src/store';
import { serveFeed, FEED_PATH } from '../src/feed';
import { captureLogs } from '../src/log';
import { apiRequest, drain, household, refreshFor, readDoc, refresh, resetFirestore, seed, world, writeDoc, type World } from './helpers/world';
import { FEED_MAX_AGE_MS, type WorkOutcome } from '../src/work';

/** An invented home in another zone than the person's device (Europe/Amsterdam). */
const HOME = { address: '12 Example Lane, Springfield, Illinois 62701', lat: 39.7817, lng: -89.6501, timeZone: 'America/Chicago', setBy: 'alice@example.com', updatedAt: 1 };

let w: World;

beforeAll(async () => {
  await resetFirestore();
});

beforeEach(async () => {
  await resetFirestore();
  await seed();
  w = world();
  checksAsked = [];
});

const call = (path: string, email: string | null, body?: Record<string, unknown>) => handleApi(w.env, apiRequest(path, email, body), undefined, { fetch: w.fetch, now: w.clock.now });

/** Sets up the person's feed (the API builds it in its own invocation before answering). */
async function setUpFeed(email: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await call('/api/feed', email, { household, refreshToken: refreshFor(email), lang: 'en', timeZone: 'Europe/Amsterdam', ...extra });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { feed: { url: string; webcal: string } };
  expect(body.feed.webcal.startsWith('webcal://')).toBe(true);
  return FEED_PATH.exec(new URL(body.feed.url).pathname)![1];
}

/** Checks feed requests asked for (`env.SELF.check`), not run: `refresh` runs everyone's. */
let checksAsked: string[][] = [];

/**
 * A feed request. Global `fetch` fails meanwhile except inside another invocation (`env.SELF`): the
 * request itself never reaches Firestore, Google or Firebase Auth.
 */
async function get(secret: string, headers: Record<string, string> = {}, method = 'GET', { work }: { work?: (pid: string) => Promise<WorkOutcome> } = {}): Promise<Response> {
  const real = globalThis.fetch;
  const self = w.env.SELF!;
  let inSelf = 0;
  w.env.SELF = {
    check: async (pids) => (checksAsked.push(pids), { checked: 0, marked: 0, sent: 0, echoes: 0, skipped: 0, errors: 0, deferred: [], paused: false }),
    mail: self.mail,
    mailWork: self.mailWork,
    work: async (pid) => {
      inSelf++;
      try {
        return await (work ?? self.work)(pid);
      } finally {
        inSelf--;
      }
    },
  };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (inSelf) return real(url, init);
    throw new Error('a feed request made a network call');
  }) as unknown as typeof fetch;
  try {
    return await serveFeed(w.env, new Request(`https://calendar.example/feed/${secret}.ics`, { headers, method }), secret, { now: w.clock.now });
  } finally {
    globalThis.fetch = real;
    w.env.SELF = self;
  }
}

const summaries = (ics: string) => new ICAL.Component(ICAL.parse(ics)).getAllSubcomponents('vevent').map((v) => String(v.getFirstPropertyValue('summary')));

describe('the feed', () => {
  test('an admin who cares for Nan: everything, valid iCalendar, the series repeating', async () => {
    const res = await get(await setUpFeed('alice@example.com'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/calendar; charset=utf-8');
    const ics = await res.text();
    expect(icsProblems(ics)).toEqual([]);
    expect(summaries(ics)).toEqual(expect.arrayContaining(['Garbage pickup', 'Checkup', 'Power bill', 'Medicine for Nan', 'To do: Buy paint']));
    expect(ics).toContain('RRULE:FREQ=WEEKLY;BYDAY=TH;WKST=SU');
    expect(ics).toContain('EXDATE;TZID=Europe/Amsterdam:20311016T070000');
    expect(ics).toContain('BEGIN:VTIMEZONE');
    // Health detail is off by default: no medicine name.
    expect(ics).not.toContain('Amoxicillin');
  });

  test('a helper’s feed has no bills and no Health', async () => {
    const ics = await (await get(await setUpFeed('helen@example.com'))).text();
    expect(summaries(ics)).not.toContain('Power bill');
    expect(ics).not.toContain('Medicine');
    expect(summaries(ics)).toEqual(expect.arrayContaining(['Garbage pickup', 'Checkup']));
  });

  test('a member who is not Nan’s carer gets no Health; a kid gets what a helper does', async () => {
    const bob = await (await get(await setUpFeed('bob@example.com'))).text();
    expect(bob).not.toContain('Medicine');
    expect(summaries(bob)).toContain('Power bill');
    const kim = await (await get(await setUpFeed('kim@example.com'))).text();
    expect(summaries(kim)).not.toContain('Power bill');
  });

  test('settings: hidden apps, Health detail, and the person’s language', async () => {
    const secret = await setUpFeed('alice@example.com', { lang: 'es' });
    await writeDoc(`households/${household}/calendarSettings/alice@example.com`, { hiddenApps: ['baby'], todos: false, bills: true, healthDetail: true, done: true, updatedAt: 5, by: 'alice@example.com' });
    await refresh(w);
    const ics = await (await get(secret)).text();
    expect(summaries(ics)).not.toContain('Checkup');
    expect(ics).toContain('Amoxicillin');
    expect(summaries(ics)).toContain('Recogida de basura');
    expect(summaries(ics).some((s) => s.startsWith('Pendiente'))).toBe(false);
  });

  test("the household's home: Home events carry its address as LOCATION, and the feed keeps the home's zone", async () => {
    const secret = await setUpFeed('helen@example.com');
    const before = await (await get(secret)).text();
    expect(before).not.toMatch(/^LOCATION/m);
    expect(before).toContain('TZID=Europe/Amsterdam');
    await writeDoc(`households/${household}`, { ...(await readDoc(`households/${household}`))!, home: HOME });
    await refresh(w);
    const ics = await (await get(secret)).text();
    expect(icsProblems(ics)).toEqual([]);
    const events = new ICAL.Component(ICAL.parse(ics)).getAllSubcomponents('vevent');
    const where = Object.fromEntries(events.map((v) => [String(v.getFirstPropertyValue('summary')), v.getFirstPropertyValue('location')]));
    expect(where['Garbage pickup']).toBe(HOME.address);
    expect(where['Checkup']).toBeNull();
    // The person's device said Amsterdam; the household lives in Chicago, so 07:00 is 07:00 there.
    expect(ics).toContain('DTSTART;TZID=America/Chicago:20310904T070000');
    expect(ics).not.toContain('TZID=Europe/Amsterdam');
  });

  test('unchanged: served again with its ETag, 304 when the client has it; a change rebuilds it', async () => {
    const secret = await setUpFeed('alice@example.com');
    const logs = captureLogs();
    const first = await get(secret);
    const etag = first.headers.get('ETag')!;
    const again = await get(secret, { 'If-None-Match': etag });
    expect(again.status).toBe(304);
    await writeDoc(`households/${household}/agenda/baby_appointment_a1`, { ...(await readDoc(`households/${household}/agenda/baby_appointment_a1`))!, title: 'Checkup at 18 months', updatedAt: Date.parse('2031-10-01T10:00:00Z') });
    // A request doesn't look: until the next check, the stored feed stands.
    expect((await get(secret, { 'If-None-Match': etag })).status).toBe(304);
    await refresh(w);
    const changed = await get(secret, { 'If-None-Match': etag });
    expect(changed.status).toBe(200);
    expect(summaries(await changed.text())).toContain('Checkup at 18 months');
    logs.restore();
    const lines = logs.lines.map((l) => JSON.parse(l) as { event: string; served?: string; built?: boolean });
    expect(lines.filter((l) => l.event === 'feed').map((l) => l.served ?? (l.built ? 'built' : '?'))).toEqual(['stored', 'not-modified', 'not-modified', 'built', 'stored']);
    // Counts only: no titles, emails or households in the logs.
    expect(logs.lines.join('\n')).not.toMatch(/Checkup|example\.com|h1/);
  });

  test('nothing changed: a check marks no work, writes nothing and queues nothing', async () => {
    await setUpFeed('alice@example.com');
    await refresh(w);
    const before = JSON.stringify((await w.env.DB.prepare('SELECT * FROM people').all()).results) + JSON.stringify((await w.env.DB.prepare('SELECT id, signal, etag, built_at FROM feeds').all()).results);
    w.clock.now += 15 * 60_000;
    const { results } = await w.env.DB.prepare('SELECT pid FROM people').all<{ pid: string }>();
    const { checkPeople } = await import('../src/check');
    const totals = await checkPeople(w.env, results.map((r) => r.pid), { fetch: w.fetch, now: w.clock.now });
    expect([totals.checked, totals.marked]).toEqual([1, 0]);
    expect(w.queue).toEqual([]);
    const after = JSON.stringify((await w.env.DB.prepare('SELECT * FROM people').all()).results) + JSON.stringify((await w.env.DB.prepare('SELECT id, signal, etag, built_at FROM feeds').all()).results);
    expect(after).toBe(before);
  });

  test('a feed with nothing stored yet: built in another invocation while the request waits; failing that, 503 and queued', async () => {
    const secret = await setUpFeed('bob@example.com');
    await w.env.DB.prepare('DELETE FROM feeds').run();
    const logs = captureLogs();
    const res = await get(secret);
    logs.restore();
    expect(res.status).toBe(200);
    expect(summaries(await res.text())).toContain('Power bill');
    expect(logs.lines.some((l) => l.includes('built-now'))).toBe(true);
    const head = await get(secret, {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers.get('ETag')).toBe(res.headers.get('ETag'));

    await w.env.DB.prepare('DELETE FROM feeds').run();
    const pending = await get(secret, {}, 'GET', { work: async () => ({ retryAfter: 30, reason: 'busy' }) });
    expect(pending.status).toBe(503);
    expect(pending.headers.get('Retry-After')).toBe('60');
    expect(w.queue.length).toBe(1);
    await drain(w);
    expect((await get(secret)).status).toBe(200);
  });

  test('a change in the portal (Health details on) reaches the feed within seconds of the calendar app asking', async () => {
    const secret = await setUpFeed('alice@example.com');
    expect(await (await get(secret)).text()).not.toContain('Amoxicillin');
    await writeDoc(`households/${household}/calendarSettings/alice@example.com`, { hiddenApps: [], todos: true, bills: true, healthDetail: true, done: true, updatedAt: 7, by: 'alice@example.com' });
    w.clock.now += 10_000;
    // The request serves what is stored and asks for a check of its person, after the answer.
    checksAsked = [];
    expect(await (await get(secret)).text()).not.toContain('Amoxicillin');
    expect(checksAsked.length).toBe(1);
    const { checkPeople } = await import('../src/check');
    expect((await checkPeople(w.env, checksAsked[0], { fetch: w.fetch, now: w.clock.now })).marked).toBe(1);
    await drain(w);
    expect(await (await get(secret)).text()).toContain('Amoxicillin');
  });

  test('a feed older than its maximum age: the request marks it stale, the next check rebuilds it', async () => {
    const secret = await setUpFeed('alice@example.com');
    const built = (await w.env.DB.prepare('SELECT built_at FROM feeds').first<{ built_at: number }>())!.built_at;
    w.clock.now += FEED_MAX_AGE_MS + 60_000;
    expect((await get(secret)).status).toBe(200);
    expect((await w.env.DB.prepare('SELECT stale FROM feeds').first<{ stale: number }>())!.stale).toBe(1);
    await refresh(w);
    const row = (await w.env.DB.prepare('SELECT stale, built_at FROM feeds').first<{ stale: number; built_at: number }>())!;
    expect(row.stale).toBe(0);
    expect(row.built_at).toBeGreaterThan(built);
  });

  test('stored sealed for its URL: the D1 row holds nothing readable, and only the secret opens it', async () => {
    const secret = await setUpFeed('alice@example.com');
    const row = (await w.env.DB.prepare('SELECT id, body FROM feeds').first<{ id: string; body: string }>())!;
    expect(row.body).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(row.id).not.toContain(secret);
    const { openFeedBody } = await import('../src/store');
    expect(await openFeedBody(w.env, 'y'.repeat(32), row.body)).toBeNull();
    expect(await openFeedBody(w.env, secret, row.body)).toContain('BEGIN:VCALENDAR');
  });

  test('rotate: the old URL stops working; revoke: no URL at all', async () => {
    const old = await setUpFeed('alice@example.com');
    const rotated = (await (await call('/api/feed/rotate', 'alice@example.com', { household })).json()) as { feed: { url: string } };
    const fresh = FEED_PATH.exec(new URL(rotated.feed.url).pathname)![1];
    expect(fresh).not.toBe(old);
    expect((await get(old)).status).toBe(404);
    // The same calendar at the new URL straight away, without a rebuild.
    expect(w.queue).toEqual([]);
    expect((await get(fresh)).status).toBe(200);
    const revoked = (await (await call('/api/feed/revoke', 'alice@example.com', { household })).json()) as { feed: null };
    expect(revoked.feed).toBeNull();
    expect((await get(fresh)).status).toBe(404);
  });

  test('someone who left the household: the feed goes', async () => {
    const secret = await setUpFeed('bob@example.com');
    const h = (await readDoc(`households/${household}`))!;
    await writeDoc(`households/${household}`, { ...h, members: (h.members as string[]).filter((m) => m !== 'bob@example.com') });
    await refresh(w);
    expect((await get(secret)).status).toBe(404);
    expect((await get(secret)).status).toBe(404);
  });

  test('signed out everywhere (the refresh token is dead): the check marks it, not a Firestore error', async () => {
    const secret = await setUpFeed('bob@example.com');
    const pid = await personId(household, 'bob@example.com');
    const { loadPerson, savePerson } = await import('../src/store');
    await savePerson(w.env, pid, { ...(await loadPerson(w.env, pid))!, refreshToken: 'rt:revoked-bob#refresh-token' });
    const { forgetTokens } = await import('../src/person');
    forgetTokens();
    const { checkPeople } = await import('../src/check');
    const totals = await checkPeople(w.env, [pid], { fetch: w.fetch, now: w.clock.now });
    expect(totals.errors).toBe(0);
    expect((await loadPerson(w.env, pid))!.signedOut).toBe(true);
    // The stored feed stands.
    expect((await get(secret)).status).toBe(200);
  });

  test('a made-up secret is a 404; the KV holds nothing readable', async () => {
    await setUpFeed('alice@example.com');
    expect((await get('x'.repeat(32))).status).toBe(404);
    const stored = [...w.env.TOKENS.map.entries()].map(([k, v]) => `${k} ${v}`).join('\n');
    // Base64url never has '@', '"', '#' or ':' after the key's prefix: any of them would be plain text.
    for (const [k, v] of w.env.TOKENS.map) {
      expect(k).toMatch(/^(feed|person):[A-Za-z0-9_-]+$/);
      expect(v).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    }
    expect(stored).not.toMatch(/@|"|#/);
  });
});

describe('the API', () => {
  test('needs a signed-in member; answers only the suite’s site', async () => {
    expect((await call(`/api/status?household=${household}`, null)).status).toBe(401);
    expect((await call(`/api/status?household=${household}`, 'mallory@example.com')).status).toBe(403);
    const preflight = await handleApi(w.env, new Request('https://calendar.example/api/feed', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), undefined, { fetch: w.fetch });
    expect(preflight.status).toBe(403);
    const ok = await call(`/api/status?household=${household}`, 'alice@example.com');
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('https://site.example');
  });

  test('Firestore over its daily quota is 503 firestore-quota, not "not a member"; down is 503 unavailable', async () => {
    const exhausted = async (url: string, init?: RequestInit) =>
      url.includes('/documents/households/') ? Response.json({ error: { code: 429, message: 'Quota exceeded.', status: 'RESOURCE_EXHAUSTED' } }, { status: 429 }) : w.fetch(url, init);
    const res = await handleApi(w.env, apiRequest(`/api/status?household=${household}`, 'alice@example.com'), undefined, { fetch: exhausted, now: w.clock.now });
    expect(res.status).toBe(503);
    expect((await res.json()) as unknown).toEqual({ error: 'firestore-quota' });
    const down = async (url: string, init?: RequestInit) => (url.includes('/documents/households/') ? Response.json({ error: { code: 503, status: 'UNAVAILABLE' } }, { status: 503 }) : w.fetch(url, init));
    const res2 = await handleApi(w.env, apiRequest(`/api/status?household=${household}`, 'alice@example.com'), undefined, { fetch: down, now: w.clock.now });
    expect(res2.status).toBe(503);
    expect((await res2.json()) as unknown).toEqual({ error: 'unavailable' });
  });

  test('the ID token: Firestore’s check is the one that counts (forged: 401); another project’s or expired claims: 401 without a call', async () => {
    const forged = async (url: string, init?: RequestInit) =>
      url.includes('/documents/households/') ? Response.json({ error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } }, { status: 401 }) : w.fetch(url, init);
    expect((await handleApi(w.env, apiRequest(`/api/status?household=${household}`, 'alice@example.com'), undefined, { fetch: forged, now: w.clock.now })).status).toBe(401);
    let calls = 0;
    const counting = async (url: string, init?: RequestInit) => (calls++, w.fetch(url, init));
    const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const now = Math.floor(Date.now() / 1000);
    for (const claims of [
      { aud: 'another-project', iss: 'https://securetoken.google.com/another-project', exp: now + 3600, email: 'alice@example.com', email_verified: true, user_id: 'u-alice' },
      { aud: 'demo-huishouden-calendar', iss: 'https://securetoken.google.com/demo-huishouden-calendar', exp: now - 10, email: 'alice@example.com', email_verified: true, user_id: 'u-alice' },
      { aud: 'demo-huishouden-calendar', iss: 'https://securetoken.google.com/demo-huishouden-calendar', exp: now + 3600, email: 'alice@example.com', email_verified: false, user_id: 'u-alice' },
    ]) {
      const req = new Request(`https://calendar.example/api/status?household=${household}`, { headers: { Origin: 'https://site.example', Authorization: `Bearer ${b64({ alg: 'none' })}.${b64(claims)}.` } });
      expect((await handleApi(w.env, req, undefined, { fetch: counting, now: w.clock.now })).status).toBe(401);
    }
    expect(calls).toBe(0);
  });

  test('the same refresh token again (each Make or rotate sends it): no exchange with Firebase Auth', async () => {
    await call('/api/feed', 'alice@example.com', { household, refreshToken: refreshFor('alice@example.com'), lang: 'en', timeZone: 'Europe/Amsterdam' });
    const before = w.authCalls.filter((c) => c === 'token').length;
    expect((await call('/api/feed/rotate', 'alice@example.com', { household, refreshToken: refreshFor('alice@example.com') })).status).toBe(200);
    expect(w.authCalls.filter((c) => c === 'token').length).toBe(before);
  });

  test('a refresh token must be the caller’s own', async () => {
    const res = await call('/api/feed', 'alice@example.com', { household, refreshToken: refreshFor('bob@example.com'), lang: 'en', timeZone: 'Europe/Amsterdam' });
    expect(res.status).toBe(400);
  });
});
