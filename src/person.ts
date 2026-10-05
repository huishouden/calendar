import { exchangeRefreshToken, FirebaseAuthError, IdTokenCache, type AuthRestOptions } from '@huishouden/pwa-kit/firebase-auth-rest';
import { decodeFields, FirestoreError, FirestoreRest, type FieldFilter } from '@huishouden/pwa-kit/firestore-rest';
import { PERSONAL_AGENDA, toAgendaItem, type AgendaItem } from '@huishouden/pwa-kit/agenda-core';
import { PERSONAL_TODOS, toTodoItem, type TodoItem } from '@huishouden/pwa-kit/todo-core';
import { isRestricted, ROLES, type Role } from '@huishouden/pwa-kit/role-core';
import { CALENDAR_SETTINGS, toCalendarSettings, contentHash, type CalendarSettings } from '@huishouden/pwa-kit/calendar-export';
import { householdTimeZone, toHome, type HouseholdHome } from '@huishouden/pwa-kit/home';
import type { Env, Fetch } from './env';
import type { PersonRecord } from './store';

/**
 * Acting as the person: their Firebase refresh token buys ID tokens, and every Firestore call
 * carries one, so the household's rules decide what is read and written, exactly as in the apps.
 * A helper's or kid's queries ask for `private == false` (the rules check queries as a whole);
 * personal items (Health) are read with `audience array-contains me`.
 */

const caches = new Map<string, IdTokenCache>();

export function authOptions(env: Env, fetchImpl?: Fetch): AuthRestOptions {
  return { projectId: env.FIREBASE_PROJECT_ID, apiKey: env.FIREBASE_API_KEY, ...(fetchImpl ? { fetch: fetchImpl } : {}) };
}

function tokenCache(env: Env, fetchImpl?: Fetch): IdTokenCache {
  const key = env.FIREBASE_PROJECT_ID;
  let cache = caches.get(key);
  if (!cache) {
    const options = authOptions(env, fetchImpl);
    cache = new IdTokenCache((refresh) => exchangeRefreshToken(options, refresh));
    caches.set(key, cache);
  }
  return cache;
}

/** For tests: forget cached ID tokens. */
export const forgetTokens = () => caches.clear();

/** The person is no longer in the household, or never was. */
export class NotMember extends Error {}

export interface View {
  household: string;
  email: string;
  role: Role;
  restricted: boolean;
  settings: CalendarSettings;
  /** When the settings were last saved (0 when never), part of the change signal. */
  settingsAt: number;
  /** The household's home (`households/{id}.home`), read with the household: its address and zone. */
  home?: HouseholdHome;
}

/**
 * The zone the person's calendar keeps: the household's home zone when it has one, else the zone
 * their device had when they set the calendar up.
 */
export const zoneOf = (view: Pick<View, 'home'>, record: Pick<PersonRecord, 'timeZone'>): string => householdTimeZone(view.home, record.timeZone);

/**
 * What else the calendar depends on, for the change signal: language, zone, and the home's address
 * (the LOCATION of things at home). Without a home it is what it was before homes, so setting none
 * rebuilds nothing.
 */
export const signalExtra = (view: Pick<View, 'home'>, record: Pick<PersonRecord, 'lang' | 'timeZone'>): string =>
  `${record.lang}|${zoneOf(view, record)}${view.home ? `|${view.home.address}` : ''}`;

export interface Loaded {
  agenda: AgendaItem[];
  todos: TodoItem[];
  /** Each list's count and sum of `updatedAt`, as the signal's aggregations would say: the signal without asking again. */
  tally: Tally[];
}

export type Tally = { count: number; sums: Record<string, number> };

/** What `aggregate(..., ['updatedAt'])` answers for these documents: how many, and the sum of their numeric `updatedAt`. */
export function tallyOf(docs: { data: Record<string, unknown> }[]): Tally {
  let sum = 0;
  for (const d of docs) if (typeof d.data.updatedAt === 'number') sum += d.data.updatedAt;
  return { count: docs.length, sums: { updatedAt: sum } };
}

export const roleOf = (data: Record<string, unknown>, email: string): Role => {
  const roles = (data.roles && typeof data.roles === 'object' ? data.roles : {}) as Record<string, unknown>;
  const members = Array.isArray(data.members) ? data.members : [];
  const r = roles[email];
  if (typeof r === 'string' && (ROLES as readonly string[]).includes(r)) return r as Role;
  return members[0] === email ? 'admin' : 'member';
};

/**
 * Reads a household's members have in common, made once per check run (src/check.ts) and used for
 * each of them: the shared lists' count and sum are the same query whoever of them asks, and only
 * ever go into each member's own change signal.
 */
export type Shared = Map<string, Promise<{ count: number; sums: Record<string, number> }>>;

export class Person {
  readonly db: FirestoreRest;
  readonly base: string;
  private readonly token: () => Promise<string>;
  private readonly fetchImpl: Fetch;
  private readonly firestoreUrl: string;

  constructor(
    readonly env: Env,
    readonly record: Pick<PersonRecord, 'household' | 'email' | 'refreshToken'>,
    fetchImpl?: Fetch,
    firestoreUrl?: string,
  ) {
    const cache = tokenCache(env, fetchImpl);
    this.token = async () => (await cache.get(record.refreshToken)).token;
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
    this.firestoreUrl = (firestoreUrl ?? env.FIRESTORE_URL ?? 'https://firestore.googleapis.com/v1').replace(/\/$/, '');
    this.db = new FirestoreRest({
      projectId: env.FIREBASE_PROJECT_ID,
      token: this.token,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      ...((firestoreUrl ?? env.FIRESTORE_URL) ? { baseUrl: firestoreUrl ?? env.FIRESTORE_URL } : {}),
    });
    this.base = `households/${record.household}`;
  }

  /** Several documents in one request (`documents:batchGet`), in order; null for a missing one. */
  async getAll(paths: string[]): Promise<(Record<string, unknown> | null)[]> {
    const root = `projects/${this.env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
    // The token first, outside the try: a sign-in that is gone must surface as Firebase's error, not as Firestore unreachable.
    const token = await this.token();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.firestoreUrl}/${root}:batchGet`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ documents: paths.map((p) => `${root}/${p}`) }),
      });
    } catch {
      throw new FirestoreError('unavailable', 'Firestore unreachable');
    }
    const parsed = (await res.json().catch(() => null)) as unknown;
    if (!res.ok || !Array.isArray(parsed)) {
      const error = (Array.isArray(parsed) ? parsed[0] : parsed) as { error?: { status?: string } } | null;
      const status = error?.error?.status ?? '';
      throw new FirestoreError(status === 'PERMISSION_DENIED' || res.status === 403 ? 'permission-denied' : status === 'UNAVAILABLE' ? 'unavailable' : 'unknown', `Firestore ${res.status} ${status}`.trim());
    }
    const found = new Map<string, Record<string, unknown>>();
    for (const r of parsed as { found?: { name: string; fields?: Record<string, never> } }[]) {
      if (r.found) found.set(r.found.name.slice(root.length + 1), decodeFields(r.found.fields));
    }
    return paths.map((p) => found.get(p) ?? null);
  }

  /**
   * Who they are in the household now, and their settings: the household and their settings in one
   * request. Throws `NotMember` when they have left.
   */
  async view(): Promise<View> {
    const email = this.record.email;
    let household: Record<string, unknown> | null;
    let settings: Record<string, unknown> | null;
    try {
      [household, settings] = await this.getAll([this.base, `${this.base}/${CALENDAR_SETTINGS}/${email}`]);
    } catch (e) {
      if (e instanceof FirestoreError && e.code === 'permission-denied') throw new NotMember('Not a member');
      throw e;
    }
    const members = Array.isArray(household?.members) ? (household!.members as unknown[]) : [];
    if (!household || !members.includes(email)) throw new NotMember('Not a member');
    const role = roleOf(household, email);
    const stored = settings ? { data: settings } : null;
    const home = toHome(household.home);
    return {
      household: this.record.household,
      email,
      role,
      restricted: isRestricted(role),
      settings: toCalendarSettings(stored?.data),
      settingsAt: typeof stored?.data.updatedAt === 'number' ? stored.data.updatedAt : 0,
      ...(home ? { home } : {}),
    };
  }

  private shared(view: View): FieldFilter[] {
    return view.restricted ? [{ field: 'private', op: 'EQUAL', value: false }] : [];
  }

  private mine(view: View): FieldFilter[] {
    return [{ field: 'audience', op: 'ARRAY_CONTAINS', value: view.email }];
  }

  /** A personal collection the rules may refuse (older rules, a kid): empty then. */
  private async optional<T>(read: () => Promise<T>, empty: T): Promise<T> {
    try {
      return await read();
    } catch (e) {
      if (e instanceof FirestoreError && e.code === 'permission-denied') return empty;
      throw e;
    }
  }

  /**
   * A short fingerprint of everything the person's calendar shows: for each list, how many items
   * and the sum of their `updatedAt` (one aggregation each), plus their role and settings. Any
   * item added, changed or removed moves it.
   */
  async signal(view: View, extra = '', shared?: Shared): Promise<string> {
    const zero = { count: 0, sums: { updatedAt: 0 } };
    const common = (collection: string) => {
      const run = () => this.db.aggregate(this.base, collection, { where: this.shared(view) }, ['updatedAt']);
      if (!shared) return run();
      const key = `${this.record.household}|${collection}|${view.restricted}`;
      let hit = shared.get(key);
      if (!hit) {
        hit = run();
        shared.set(key, hit);
        // A failed read is not kept: the next member asks again, as themselves.
        hit.catch(() => shared.delete(key));
      }
      return hit;
    };
    const [agenda, personal, todos, personalTodos] = await Promise.all([
      common('agenda'),
      this.optional(() => this.db.aggregate(this.base, PERSONAL_AGENDA, { where: this.mine(view) }, ['updatedAt']), zero),
      view.settings.todos ? common('todos') : Promise.resolve(zero),
      view.settings.todos ? this.optional(() => this.db.aggregate(this.base, PERSONAL_TODOS, { where: this.mine(view) }, ['updatedAt']), zero) : Promise.resolve(zero),
    ]);
    return signalFrom(view, [agenda, personal, todos, personalTodos], extra);
  }

  /** The same signal from what `load` read: no aggregations. */
  signalOf(view: View, loaded: Loaded, extra = ''): string {
    return signalFrom(view, loaded.tally, extra);
  }

  /** Everything the person can read that a calendar may show. */
  async load(view: View): Promise<Loaded> {
    const [agenda, personal, todos, personalTodos] = await Promise.all([
      this.db.query(this.base, 'agenda', { where: this.shared(view) }),
      this.optional(() => this.db.query(this.base, PERSONAL_AGENDA, { where: this.mine(view) }), []),
      view.settings.todos ? this.db.query(this.base, 'todos', { where: this.shared(view) }) : Promise.resolve([]),
      view.settings.todos ? this.optional(() => this.db.query(this.base, PERSONAL_TODOS, { where: this.mine(view) }), []) : Promise.resolve([]),
    ]);
    return {
      tally: [agenda, personal, todos, personalTodos].map(tallyOf),
      agenda: [...agenda, ...personal].map((d) => ({ ...toAgendaItem(d.id, d.data), ...(d.path.includes(`/${PERSONAL_AGENDA}/`) ? { audience: toAgendaItem(d.id, d.data).audience ?? [] } : {}) })),
      todos: [...todos, ...personalTodos].map((d) => toTodoItem(d.id, d.data)),
    };
  }
}

const signalFrom = (view: View, tallies: Tally[], extra: string): string =>
  contentHash(JSON.stringify([...tallies, view.role, view.settingsAt, view.settings, extra]));

/** Firestore said the project's daily quota is used up (429 RESOURCE_EXHAUSTED; Spark resets at midnight Pacific). */
export const overQuota = (e: unknown): boolean => e instanceof FirestoreError && /\b429\b|RESOURCE_EXHAUSTED/.test(e.message);

/** Whether an error means the person's sign-in is gone for good (signed out everywhere, account disabled). */
export const signInGone = (e: unknown): boolean => e instanceof FirebaseAuthError && e.kind === 'revoked';
