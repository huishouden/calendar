import { FirebaseAuthError, verifyIdToken } from '@huishouden/pwa-kit/firebase-auth-rest';
import { checkProductPhotoRequest, cleanProducts, productPrompt, type FoundProduct, type PhotoAnswer, type ProductPhotoResponse } from '@huishouden/pwa-kit/product-photo-core';
import { sha256 } from './b64';
import { firestoreQuota, refusedBy, requestBudget } from './budget';
import type { Env, Fetch } from './env';
import { log } from './log';
import { authOptions, claimedPerson, HouseholdRefusal, memberHousehold } from './person';
import { householdKey } from './store';

/**
 * Add by photo (Groceries): product names read from a photo by a vision model on Workers AI, for a
 * member of the household. Photos arrive already small (768 pixels, JPEG; pwa-kit `shrinkPhoto`),
 * one per request, go to the model once and are kept nowhere: not stored, not logged. The log line
 * has counts only, never a photo, a name read from one, a household or a person.
 *
 * Who: the caller's Firebase ID token and their membership of the household, read from Firestore
 * as them (`memberHousehold`, as every portal call: Firestore checks the token; the rules refuse
 * anyone else), then remembered for MEMBER_TTL_MS in D1 (`photo-member:<hash>`, the token checked
 * by Firebase Auth meanwhile). A session of photos then costs one Firestore read when its photos
 * wait for the first answer (pwa-kit `readProductPhotos` sends the first alone); requests sent
 * before any answer each read once. Someone removed from the household can still spend its photos
 * (never read its data) until their remembered check expires.
 *
 * Free: Workers AI's daily allocation (10,000 neurons on the Free plan, reset at 00:00 UTC) is the
 * only cost. Photos read are counted in D1's `meta` per UTC day, and a request is refused once a
 * count has reached its cap:
 *
 * | Key | Cap (wrangler.toml) |
 * |---|---|
 * | `photo:<day>:<household hash>` | `PHOTO_HOUSEHOLD_DAILY` photos |
 * | `photo:<day>` | `PHOTO_DAILY` photos, everyone together |
 * | `photo-neurons:<day>` | `PHOTO_DAILY_NEURONS`: the day's measured neurons, after which no photo is sent |
 * | `photo-allocation:<day>` | 1 once Workers AI said its free allocation is used up (error 4006) |
 *
 * A photo is counted once read, so one the model couldn't read costs nothing, and a burst can pass
 * a cap by the photos already in flight (the app sends at most three at a time). When Workers AI
 * itself says the day's allocation is used up, everyone is capped until the next UTC day.
 */

/** Reads packages well, follows the JSON schema; 28 to 30 neurons for a 768-pixel photo (staging, 2026-10-14). */
export const PHOTO_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';
/** Asked once when the first fails (busy, or an error): about 33 neurons a photo. */
export const PHOTO_FALLBACK_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';

/** Neurons per million input and output tokens (Workers AI pricing), for an answer without `usage.neurons`. */
const RATES: Record<string, [number, number]> = {
  [PHOTO_MODEL]: [31_876, 50_488],
  [PHOTO_FALLBACK_MODEL]: [24_545, 77_273],
};

/** Longest answer asked for: a dozen products. */
const MAX_TOKENS = 400;

/** How long a member's check is remembered: a session of photos, and how long someone removed can still spend the household's. */
export const MEMBER_TTL_MS = 10 * 60_000;

export class PhotoHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** A cap from wrangler.toml: digits only, so a typo fails loudly instead of lifting the cap. */
export function photoCap(name: string, value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value.trim())) throw new Error(`${name} must be a whole number, not ${JSON.stringify(value)}`);
  return Number(value.trim());
}

/** The UTC day of `now`: when Workers AI's free allocation starts again. */
export const photoDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

interface AiAnswer {
  response?: unknown;
  usage?: { prompt_tokens?: number; completion_tokens?: number; neurons?: number };
}

/** Workers AI's "daily free allocation used up" (4006), as opposed to a busy or failing model. */
export const allocationUsed = (e: unknown): boolean => /\b4006\b|daily free allocation|neurons? (?:limit|allocation)/i.test(e instanceof Error ? e.message : String(e));

function neuronsOf(model: string, answer: AiAnswer): number {
  const u = answer.usage ?? {};
  if (typeof u.neurons === 'number' && Number.isFinite(u.neurons)) return u.neurons;
  const [inRate, outRate] = RATES[model] ?? RATES[PHOTO_MODEL];
  return ((u.prompt_tokens ?? 0) * inRate + (u.completion_tokens ?? 0) * outRate) / 1e6;
}

/** One photo's reading: the products and what it cost, or why there is none (`allocation`: Workers AI's free allocation is used up). */
export type OnePhoto = { products: FoundProduct[]; neurons: number; model: string } | { error: 'allocation' | 'failed' };

/**
 * One photo through the model (the fallback once on any other failure). Runs in an invocation of
 * its own (the Fanout entrypoint's `photo`, src/index.ts), so handing a photo to Workers AI never
 * shares the request's 10 ms of CPU.
 */
export async function readOnePhoto(env: Pick<Env, 'AI'>, dataUrl: string, categories: string[]): Promise<OnePhoto> {
  if (!env.AI) return { error: 'failed' };
  const { system, schema } = productPrompt(categories);
  const input = {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: [{ type: 'text', text: 'The photo:' }, { type: 'image_url', image_url: { url: dataUrl } }] },
    ],
    max_tokens: MAX_TOKENS,
    temperature: 0,
    response_format: { type: 'json_schema', json_schema: schema },
  };
  for (const model of [PHOTO_MODEL, PHOTO_FALLBACK_MODEL]) {
    try {
      const answer = (await env.AI.run(model as Parameters<Ai['run']>[0], input as never)) as AiAnswer;
      return { products: cleanProducts(answer.response, categories), neurons: neuronsOf(model, answer), model };
    } catch (e) {
      if (allocationUsed(e)) return { error: 'allocation' };
    }
  }
  return { error: 'failed' };
}

export interface PhotoDeps {
  fetch?: Fetch;
  now: number;
  firestoreUrl?: string;
}

/** The day's counts, as read from D1. */
export interface PhotoDay {
  household: number;
  everyone: number;
  neurons: number;
  /** Workers AI said its allocation is used up today. */
  allocation: boolean;
}

/** Whose cap stops a photo today, or null when it may be read. */
export function photoCapped(day: PhotoDay, caps: { household: number; everyone: number; neurons: number }): 'household' | 'everyone' | null {
  if (day.allocation || day.everyone >= caps.everyone || day.neurons >= caps.neurons) return 'everyone';
  if (day.household >= caps.household) return 'household';
  return null;
}

const add = (env: Env, key: string, n: number) => env.DB.prepare('INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = value + ?2').bind(key, n);
const valueOf = (env: Env, key: string) => env.DB.prepare('SELECT value FROM meta WHERE key = ?1').bind(key);

/**
 * `POST /api/photo/products`: the caller checked, the caps, then the photo in an invocation of its
 * own. Four subrequests (each about 1 ms of the request's 10 ms of CPU): D1 (the member check
 * remembered and the day's counts), Firebase Auth's token check (a member remembered) or the
 * household read as them (Firestore checks the token, the rules the membership), the photo's
 * invocation, D1 (the counts and the member check kept).
 */
export async function photoRequest(env: Env, request: Request, body: Record<string, unknown>, deps: PhotoDeps): Promise<ProductPhotoResponse> {
  if (!env.AI) throw new PhotoHttpError(501, 'photos-off');
  const checked = checkProductPhotoRequest(body);
  if (typeof checked === 'string') throw new PhotoHttpError(400, checked);
  const caps = {
    household: photoCap('PHOTO_HOUSEHOLD_DAILY', env.PHOTO_HOUSEHOLD_DAILY),
    everyone: photoCap('PHOTO_DAILY', env.PHOTO_DAILY),
    neurons: photoCap('PHOTO_DAILY_NEURONS', env.PHOTO_DAILY_NEURONS),
  };
  // Who the token says, read without a call; checked below by Firebase Auth or Firestore.
  const idToken = /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '')?.[1];
  const claimed = idToken ? claimedPerson(env, idToken) : null;
  if (!idToken || !claimed) throw new PhotoHttpError(401, 'sign-in');
  const started = Date.now();
  const day = photoDay(deps.now);
  const keys = {
    member: `photo-member:${await sha256(`${checked.household}\u0000${claimed.email}`)}`,
    household: `photo:${day}:${await householdKey(checked.household)}`,
    everyone: `photo:${day}`,
    neurons: `photo-neurons:${day}`,
    allocation: `photo-allocation:${day}`,
  };
  const [until, household, everyone, neuronsToday, allocation] = (
    await env.DB.batch<{ value: number }>([keys.member, keys.household, keys.everyone, keys.neurons, keys.allocation].map((k) => valueOf(env, k)))
  ).map((r) => r.results?.[0]?.value ?? 0);

  const cached = until > deps.now;
  if (cached) {
    // A member remembered: Firebase Auth checks the token is still good (and not revoked).
    try {
      await verifyIdToken(authOptions(env, deps.fetch), idToken);
    } catch (e) {
      throw e instanceof FirebaseAuthError && e.kind === 'unavailable' ? new PhotoHttpError(503, 'unavailable') : new PhotoHttpError(401, 'sign-in');
    }
  } else {
    // The household read as them, as every portal call does (src/api.ts `caller`).
    await memberHousehold(env, idToken, checked.household, claimed.email, { fetch: requestBudget().fetch(deps.fetch ?? ((u, i) => fetch(u, i))), firestoreUrl: deps.firestoreUrl }).catch((e: unknown) => {
      if (e instanceof HouseholdRefusal) throw new PhotoHttpError(e.status, e.code);
      // Firestore's quota or this request's read cap: handleApi answers it as what it is.
      if (firestoreQuota(e) || refusedBy(e)) throw e;
      throw new PhotoHttpError(503, 'unavailable');
    });
  }

  // One photo a request (pwa-kit PRODUCT_PHOTO_LIMITS.photosPerRequest): it is read, or capped.
  let capped: ProductPhotoResponse['capped'] = photoCapped({ household, everyone, neurons: neuronsToday, allocation: allocation > 0 }, caps) ?? undefined;

  let neurons = 0;
  let read = 0;
  let products = 0;
  let failed = 0;
  let exhausted = false;
  const models = new Set<string>();
  const readOne = (dataUrl: string) => (env.SELF ? env.SELF.photo(dataUrl, checked.categories) : readOnePhoto(env, dataUrl, checked.categories));
  const photos: PhotoAnswer[] = await Promise.all(
    checked.photos.map(async (dataUrl): Promise<PhotoAnswer> => {
      if (capped) return { capped: true };
      const answer = await readOne(dataUrl).catch((): OnePhoto => ({ error: 'failed' }));
      if ('products' in answer) {
        read++;
        neurons += answer.neurons;
        products += answer.products.length;
        models.add(answer.model);
        return { products: answer.products };
      }
      if (answer.error === 'allocation') {
        exhausted = true;
        return { capped: true };
      }
      failed++;
      return { error: 'failed' };
    }),
  );
  if (exhausted) capped = 'everyone';

  // What was read and the member check, kept in one round trip; Workers AI's allocation used up caps everyone today.
  const writes: D1PreparedStatement[] = [];
  if (!cached) writes.push(env.DB.prepare('INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(keys.member, deps.now + MEMBER_TTL_MS));
  if (read) writes.push(add(env, keys.household, read), add(env, keys.everyone, read));
  if (neurons > 0) writes.push(add(env, keys.neurons, Math.ceil(neurons)));
  if (exhausted) writes.push(env.DB.prepare('INSERT INTO meta (key, value) VALUES (?1, 1) ON CONFLICT(key) DO UPDATE SET value = 1').bind(keys.allocation));
  if (writes.length) await env.DB.batch(writes);
  const left = Math.max(0, caps.household - household - read);
  log('photo', {
    photos: checked.photos.length,
    read,
    products,
    failed,
    neurons: Math.round(neurons * 10) / 10,
    model: [...models].map((m) => m.split('/').pop()).join(',') || undefined,
    member: cached ? 'remembered' : 'read',
    capped,
    left,
    ms: Date.now() - started,
  });
  return { photos, ...(capped ? { capped } : {}), left };
}

/** Old days' counts and expired member checks (src/tick.ts, hourly). */
export async function forgetPhotos(env: Env, now: number): Promise<void> {
  const yesterday = photoDay(now - 86_400_000);
  await env.DB.prepare(
    "DELETE FROM meta WHERE (key LIKE 'photo-member:%' AND value < ?1) OR (key LIKE 'photo:%' AND key < ?2) OR (key LIKE 'photo-neurons:%' AND key < ?3) OR (key LIKE 'photo-allocation:%' AND key < ?4)",
  )
    .bind(now, `photo:${yesterday}`, `photo-neurons:${yesterday}`, `photo-allocation:${yesterday}`)
    .run();
}
