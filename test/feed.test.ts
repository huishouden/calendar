import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import ICAL from 'ical.js';
import { icsProblems } from '@huishouden/pwa-kit/ics';
import { handleApi } from '../src/api';
import { serveFeed, FEED_PATH } from '../src/feed';
import { captureLogs } from '../src/log';
import { apiRequest, household, refreshFor, readDoc, resetFirestore, seed, world, writeDoc, type World } from './helpers/world';

let w: World;

beforeAll(async () => {
  await resetFirestore();
});

beforeEach(async () => {
  await resetFirestore();
  await seed();
  w = world();
});

const call = (path: string, email: string | null, body?: Record<string, unknown>) => handleApi(w.env, apiRequest(path, email, body), undefined, { fetch: w.fetch, now: w.clock.now });

async function setUpFeed(email: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await call('/api/feed', email, { household, refreshToken: refreshFor(email), lang: 'en', timeZone: 'Europe/Amsterdam', ...extra });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { feed: { url: string; webcal: string } };
  expect(body.feed.webcal.startsWith('webcal://')).toBe(true);
  return FEED_PATH.exec(new URL(body.feed.url).pathname)![1];
}

const get = (secret: string, headers: Record<string, string> = {}) => serveFeed(w.env, new Request(`https://calendar.example/feed/${secret}.ics`, { headers }), secret, { fetch: w.fetch, now: w.clock.now });

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
    const ics = await (await get(secret)).text();
    expect(summaries(ics)).not.toContain('Checkup');
    expect(ics).toContain('Amoxicillin');
    expect(summaries(ics)).toContain('Recogida de basura');
    expect(summaries(ics).some((s) => s.startsWith('Pendiente'))).toBe(false);
  });

  test('unchanged: served again with its ETag, 304 when the client has it; a change rebuilds it', async () => {
    const secret = await setUpFeed('alice@example.com');
    const logs = captureLogs();
    const first = await get(secret);
    const etag = first.headers.get('ETag')!;
    const again = await get(secret, { 'If-None-Match': etag });
    expect(again.status).toBe(304);
    await writeDoc(`households/${household}/agenda/baby_appointment_a1`, { ...(await readDoc(`households/${household}/agenda/baby_appointment_a1`))!, title: 'Checkup at 18 months', updatedAt: Date.parse('2031-10-01T10:00:00Z') });
    const changed = await get(secret, { 'If-None-Match': etag });
    expect(changed.status).toBe(200);
    expect(summaries(await changed.text())).toContain('Checkup at 18 months');
    logs.restore();
    expect(logs.lines.map((l) => JSON.parse(l).served)).toEqual(['built', 'cached', 'built']);
    // Counts only: no titles, emails or households in the logs.
    expect(logs.lines.join('\n')).not.toMatch(/Checkup|example\.com|h1/);
  });

  test('rotate: the old URL stops working; revoke: no URL at all', async () => {
    const old = await setUpFeed('alice@example.com');
    const rotated = (await (await call('/api/feed/rotate', 'alice@example.com', { household })).json()) as { feed: { url: string } };
    const fresh = FEED_PATH.exec(new URL(rotated.feed.url).pathname)![1];
    expect(fresh).not.toBe(old);
    expect((await get(old)).status).toBe(404);
    expect((await get(fresh)).status).toBe(200);
    const revoked = (await (await call('/api/feed/revoke', 'alice@example.com', { household })).json()) as { feed: null };
    expect(revoked.feed).toBeNull();
    expect((await get(fresh)).status).toBe(404);
  });

  test('someone who left the household: the feed goes', async () => {
    const secret = await setUpFeed('bob@example.com');
    const h = (await readDoc(`households/${household}`))!;
    await writeDoc(`households/${household}`, { ...h, members: (h.members as string[]).filter((m) => m !== 'bob@example.com') });
    expect((await get(secret)).status).toBe(404);
    expect((await get(secret)).status).toBe(404);
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

  test('a refresh token must be the caller’s own', async () => {
    const res = await call('/api/feed', 'alice@example.com', { household, refreshToken: refreshFor('bob@example.com'), lang: 'en', timeZone: 'Europe/Amsterdam' });
    expect(res.status).toBe(400);
  });
});
