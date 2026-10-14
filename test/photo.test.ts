import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { expectReads } from '@huishouden/pwa-kit/read-test';
import answers from './fixtures/photo-model-answers.json';
import { handleApi } from '../src/api';
import { captureLogs } from '../src/log';
import { forgetPhotos, MEMBER_TTL_MS, PHOTO_FALLBACK_MODEL, PHOTO_MODEL, photoCap, photoCapped, photoDay } from '../src/photo';
import { apiRequest, FIRESTORE, household, resetFirestore, seed, world, writeDoc, type World } from './helpers/world';

// Add by photo (src/photo.ts): a member's photos read by a stand-in for Workers AI, on the fixture
// household (invented) under the household's real rules. Photos are invented bytes.

const SECTIONS = ['Dairy & Eggs', 'Pantry & Dry Goods', 'Other'];
const photo = (n: number) => `data:image/jpeg;base64,${btoa(`invented photo ${n}`.padEnd(48, '.'))}`;

type Answer = { response?: unknown; usage?: Record<string, unknown> } | Error;
let w: World;
let calls: { model: string; input: { messages: { content: unknown }[]; response_format?: unknown } }[];
let script: Answer[];

beforeAll(async () => {
  await resetFirestore();
});

beforeEach(async () => {
  await resetFirestore();
  await seed();
  w = world();
  calls = [];
  script = [];
  w.env.AI = {
    run: async (model: string, input: never) => {
      calls.push({ model, input });
      const next = script.shift() ?? answers.creamerAndWhipped;
      if (next instanceof Error) throw next;
      return next;
    },
  } as unknown as Ai;
  Object.assign(w.env, { PHOTO_HOUSEHOLD_DAILY: '5', PHOTO_DAILY: '8', PHOTO_DAILY_NEURONS: '6000' });
});

let restore = () => {};
afterEach(() => restore());

const post = (email: string | null, body: Record<string, unknown>, fetch = w.fetch) =>
  handleApi(w.env, apiRequest('/api/photo/products', email, { household, categories: SECTIONS, ...body }), undefined, { fetch, now: w.clock.now, firestoreUrl: FIRESTORE });
type Body = { photos: unknown[]; capped?: string; left?: number };
const read = async (email: string, n: number, inHousehold = household): Promise<Body> => {
  const res = await post(email, { household: inHousehold, photos: [photo(n)] });
  expect(res.status).toBe(200);
  return (await res.json()) as Body;
};
const counted = async (key: string) => (await w.env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first<{ value: number }>())?.value ?? 0;

describe('reading a photo', () => {
  test("a member's photo: the products, sections only from the app's list, the day counted", async () => {
    script = [answers.creamerAndWhipped];
    const body = await read('alice@example.com', 1);
    expect(body).toEqual({
      photos: [{ products: [{ name: 'Coffee mate Italian Sweet Crème creamer, Zero Sugar', category: 'Dairy & Eggs' }, { name: 'Reddi-wip Original Whipped Topping', category: 'Dairy & Eggs' }] }],
      left: 4,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(PHOTO_MODEL);
    expect(JSON.stringify(calls[0].input.messages)).toContain(photo(1));
    expect(JSON.stringify(calls[0].input.response_format)).toContain('Pantry & Dry Goods');
    const day = photoDay(w.clock.now);
    expect(await counted(`photo:${day}`)).toBe(1);
    expect(await counted(`photo-neurons:${day}`)).toBe(29);
  });

  test('a fenced answer tidied, its neurons counted from the tokens; helpers may too', async () => {
    script = [answers.threeProducts];
    const body = await read('helen@example.com', 1);
    expect(body.photos[0]).toEqual({
      products: [
        { name: 'Barilla Spaghetti n.5', category: 'Pantry & Dry Goods' },
        { name: 'Heinz Tomato Ketchup', category: 'Pantry & Dry Goods' },
        { name: 'Reddi-wip Original Whipped Topping Made With Real Cream', category: 'Dairy & Eggs' },
      ],
    });
    // 819 × 31,876 + 72 × 50,488 per million: 29.7, rounded up.
    expect(await counted(`photo-neurons:${photoDay(w.clock.now)}`)).toBe(30);
  });

  test('the model failing: the other model once; both failing: failed, and not counted', async () => {
    script = [new Error('3040: Capacity temporarily exceeded'), answers.creamerAndWhipped];
    expect((await read('alice@example.com', 1)).photos[0]).toHaveProperty('products');
    expect(calls.map((c) => c.model)).toEqual([PHOTO_MODEL, PHOTO_FALLBACK_MODEL]);
    script = [new Error('3040'), new Error('5000: internal')];
    expect(await read('alice@example.com', 2)).toEqual({ photos: [{ error: 'failed' }], left: 4 });
    expect(await counted(`photo:${photoDay(w.clock.now)}`)).toBe(1);
  });
});

describe('who may', () => {
  test('signed out: 401; not a member: 403; neither reaches the model', async () => {
    expect((await post(null, { photos: [photo(1)] })).status).toBe(401);
    expect((await post('stranger@example.com', { photos: [photo(1)] })).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test('a member is remembered for MEMBER_TTL_MS; someone removed is refused after it', async () => {
    await read('bob@example.com', 1);
    await writeDoc(`households/${household}`, { name: 'Home', members: ['alice@example.com'], joined: ['alice@example.com'], createdAt: 1 });
    expect((await post('bob@example.com', { photos: [photo(2)] })).status).toBe(200);
    w.clock.now += MEMBER_TTL_MS + 1;
    expect((await post('bob@example.com', { photos: [photo(3)] })).status).toBe(403);
  });

  test('a household that is not an id (a path to another document) is refused before anything is read', async () => {
    const res = await post('alice@example.com', { household: `${household}/lists/x`, photos: [photo(1)] });
    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toEqual({ error: 'household' });
    expect(calls).toHaveLength(0);
  });

  test('a body over a megabyte: 413, whether or not it says its length', async () => {
    const big = { household, categories: SECTIONS, photos: [`data:image/jpeg;base64,${'A'.repeat(1_100_000)}`] };
    const res = await handleApi(w.env, apiRequest('/api/photo/products', 'alice@example.com', big), undefined, { fetch: w.fetch, now: w.clock.now, firestoreUrl: FIRESTORE });
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  test("Firestore's daily quota on the member check is answered as the quota, not an outage", async () => {
    const quota = async (url: string, init?: RequestInit) =>
      url.includes('/documents/')
        ? Response.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded.' } }, { status: 429 })
        : w.fetch(url, init);
    const res = await post('alice@example.com', { photos: [photo(1)] }, quota);
    expect(res.status).toBe(503);
    expect((await res.json()) as unknown).toEqual({ error: 'firestore-quota' });
    expect(res.headers.get('Retry-After')).toBe('3600');
    expect(calls).toHaveLength(0);
  });

  test('a bad request says which part, before the model', async () => {
    const res = await post('alice@example.com', { photos: ['data:image/png;base64,AAAA'] });
    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toEqual({ error: 'photos' });
    expect((await post('alice@example.com', { photos: [photo(1), photo(2)] })).status).toBe(400);
    expect((await post('alice@example.com', { photos: [photo(1)], categories: ['x"y'] })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test('without the AI binding: 501', async () => {
    delete w.env.AI;
    expect((await post('alice@example.com', { photos: [photo(1)] })).status).toBe(501);
  });
});

describe('caps', () => {
  test("the household's day: then capped, whoever asks", async () => {
    for (let i = 1; i <= 5; i++) await read(i % 2 ? 'alice@example.com' : 'bob@example.com', i);
    expect(await read('kim@example.com', 6)).toEqual({ photos: [{ capped: true }], capped: 'household', left: 0 });
    expect(calls).toHaveLength(5);
  });

  test("everyone's day: another household is capped too", async () => {
    await seed({ 'households/h2': { name: 'Other', members: ['olga@example.com'], joined: ['olga@example.com'], createdAt: 1 } });
    Object.assign(w.env, { PHOTO_DAILY: '2' });
    await read('alice@example.com', 1);
    await read('alice@example.com', 2);
    expect(await read('olga@example.com', 3, 'h2')).toEqual({ photos: [{ capped: true }], capped: 'everyone', left: 5 });
  });

  test("the day's neurons reached: nothing is sent", async () => {
    Object.assign(w.env, { PHOTO_DAILY_NEURONS: '50' });
    await read('alice@example.com', 1);
    await read('alice@example.com', 2);
    expect(await read('alice@example.com', 3)).toEqual({ photos: [{ capped: true }], capped: 'everyone', left: 3 });
    expect(calls).toHaveLength(2);
  });

  test("Workers AI's free allocation used up: everyone capped until the next UTC day", async () => {
    script = [new Error("4006: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare's Workers Paid plan")];
    expect(await read('alice@example.com', 1)).toEqual({ photos: [{ capped: true }], capped: 'everyone', left: 5 });
    expect(calls).toHaveLength(1);
    // Kept apart from the photo count: raising PHOTO_DAILY doesn't lift it.
    expect(await counted(`photo:${photoDay(w.clock.now)}`)).toBe(0);
    Object.assign(w.env, { PHOTO_DAILY: '500' });
    expect((await read('bob@example.com', 2)).photos).toEqual([{ capped: true }]);
    w.clock.now += 86_400_000;
    expect((await read('bob@example.com', 2)).photos[0]).toHaveProperty('products');
  });

  test('whose cap: everyone first (photos, neurons, Workers AI), then the household', () => {
    const caps = { household: 25, everyone: 150, neurons: 6000 };
    const day = { household: 0, everyone: 0, neurons: 0, allocation: false };
    expect(photoCapped(day, caps)).toBeNull();
    expect(photoCapped({ ...day, household: 25 }, caps)).toBe('household');
    expect(photoCapped({ ...day, household: 25, everyone: 150 }, caps)).toBe('everyone');
    expect(photoCapped({ ...day, neurons: 6000 }, caps)).toBe('everyone');
    expect(photoCapped({ ...day, allocation: true }, caps)).toBe('everyone');
    expect(photoCapped({ ...day, household: 24, everyone: 149, neurons: 5999 }, caps)).toBeNull();
  });

  test('a cap that is not a number fails loudly', () => {
    expect(photoCap('PHOTO_DAILY', '150')).toBe(150);
    expect(() => photoCap('PHOTO_DAILY', '15O')).toThrow('PHOTO_DAILY must be a whole number');
    expect(() => photoCap('PHOTO_DAILY', undefined)).toThrow();
  });

  test("yesterday's counts and expired member checks are forgotten", async () => {
    await read('alice@example.com', 1);
    const before = (await w.env.DB.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'photo%'").first<{ n: number }>())!.n;
    expect(before).toBe(4);
    script = [new Error('4006: daily free allocation used')];
    await read('alice@example.com', 2);
    expect(await counted(`photo-allocation:${photoDay(w.clock.now)}`)).toBe(1);
    await forgetPhotos(w.env, w.clock.now + 2 * 86_400_000);
    expect((await w.env.DB.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'photo%'").first<{ n: number }>())!.n).toBe(0);
  });
});

describe('privacy and reads', () => {
  test('the log has counts only: no photo, no name read from it, no household, no person', async () => {
    const logs = captureLogs();
    restore = logs.restore;
    await read('alice@example.com', 1);
    const line = logs.lines.find((l) => l.includes('"photo"'))!;
    expect(JSON.parse(line)).toMatchObject({ event: 'photo', photos: 1, read: 1, products: 2, failed: 0, neurons: 28.8, model: 'mistral-small-3.1-24b-instruct', member: 'read', left: 4 });
    const all = logs.lines.join('\n');
    for (const secret of ['base64', 'invented photo', 'Coffee mate', 'Reddi-wip', household, 'alice']) expect(all).not.toContain(secret);
  });

  test('requests sent before any answer each read the household once (the app sends its first alone)', async () => {
    await expectReads(async (meter) => {
      const all = await Promise.all([1, 2, 3].map((i) => post('alice@example.com', { photos: [photo(i)] }, meter(w.fetch))));
      expect(all.map((r) => r.status)).toEqual([200, 200, 200]);
    }, { max: 3, min: 3, label: 'Add by photo, three sent at once' });
  });

  test("one Firestore read for a member's first photo in MEMBER_TTL_MS (the household), none for the next", async () => {
    await expectReads(async (meter) => {
      expect((await post('alice@example.com', { photos: [photo(1)] }, meter(w.fetch))).status).toBe(200);
    }, { max: 1, min: 1, label: 'Add by photo, first photo' });
    await expectReads(async (meter) => {
      for (let i = 2; i <= 4; i++) expect((await post('alice@example.com', { photos: [photo(i)] }, meter(w.fetch))).status).toBe(200);
    }, { max: 0, label: 'Add by photo, three more photos' });
  });
});
