import { exchangeRefreshToken, FirebaseAuthError, IdTokenCache, type AuthRestOptions } from '@huishouden/pwa-kit/firebase-auth-rest';
import { FirestoreError, FirestoreRest, type FieldFilter } from '@huishouden/pwa-kit/firestore-rest';
import { PERSONAL_AGENDA, toAgendaItem, type AgendaItem } from '@huishouden/pwa-kit/agenda-core';
import { PERSONAL_TODOS, toTodoItem, type TodoItem } from '@huishouden/pwa-kit/todo-core';
import { isRestricted, ROLES, type Role } from '@huishouden/pwa-kit/role-core';
import { CALENDAR_SETTINGS, toCalendarSettings, contentHash, type CalendarSettings } from '@huishouden/pwa-kit/calendar-export';
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
}

export interface Loaded {
  agenda: AgendaItem[];
  todos: TodoItem[];
}

const roleOf = (data: Record<string, unknown>, email: string): Role => {
  const roles = (data.roles && typeof data.roles === 'object' ? data.roles : {}) as Record<string, unknown>;
  const members = Array.isArray(data.members) ? data.members : [];
  const r = roles[email];
  if (typeof r === 'string' && (ROLES as readonly string[]).includes(r)) return r as Role;
  return members[0] === email ? 'admin' : 'member';
};

export class Person {
  readonly db: FirestoreRest;
  readonly base: string;

  constructor(
    readonly env: Env,
    readonly record: Pick<PersonRecord, 'household' | 'email' | 'refreshToken'>,
    fetchImpl?: Fetch,
    firestoreUrl?: string,
  ) {
    const cache = tokenCache(env, fetchImpl);
    this.db = new FirestoreRest({
      projectId: env.FIREBASE_PROJECT_ID,
      token: async () => (await cache.get(record.refreshToken)).token,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      ...((firestoreUrl ?? env.FIRESTORE_URL) ? { baseUrl: firestoreUrl ?? env.FIRESTORE_URL } : {}),
    });
    this.base = `households/${record.household}`;
  }

  /** Who they are in the household now, and their settings. Throws `NotMember` when they have left. */
  async view(): Promise<View> {
    const email = this.record.email;
    let household;
    try {
      household = await this.db.get(this.base);
    } catch (e) {
      if (e instanceof FirestoreError && e.code === 'permission-denied') throw new NotMember('Not a member');
      throw e;
    }
    const members = Array.isArray(household?.data.members) ? (household!.data.members as unknown[]) : [];
    if (!household || !members.includes(email)) throw new NotMember('Not a member');
    const role = roleOf(household.data, email);
    const stored = await this.db.get(`${this.base}/${CALENDAR_SETTINGS}/${email}`);
    return {
      household: this.record.household,
      email,
      role,
      restricted: isRestricted(role),
      settings: toCalendarSettings(stored?.data),
      settingsAt: typeof stored?.data.updatedAt === 'number' ? stored.data.updatedAt : 0,
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
  async signal(view: View, extra = ''): Promise<string> {
    const zero = { count: 0, sums: { updatedAt: 0 } };
    const [agenda, personal, todos, personalTodos] = await Promise.all([
      this.db.aggregate(this.base, 'agenda', { where: this.shared(view) }, ['updatedAt']),
      this.optional(() => this.db.aggregate(this.base, PERSONAL_AGENDA, { where: this.mine(view) }, ['updatedAt']), zero),
      view.settings.todos ? this.db.aggregate(this.base, 'todos', { where: this.shared(view) }, ['updatedAt']) : Promise.resolve(zero),
      view.settings.todos ? this.optional(() => this.db.aggregate(this.base, PERSONAL_TODOS, { where: this.mine(view) }, ['updatedAt']), zero) : Promise.resolve(zero),
    ]);
    return contentHash(JSON.stringify([agenda, personal, todos, personalTodos, view.role, view.settingsAt, view.settings, extra]));
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
      agenda: [...agenda, ...personal].map((d) => ({ ...toAgendaItem(d.id, d.data), ...(d.path.includes(`/${PERSONAL_AGENDA}/`) ? { audience: toAgendaItem(d.id, d.data).audience ?? [] } : {}) })),
      todos: [...todos, ...personalTodos].map((d) => toTodoItem(d.id, d.data)),
    };
  }
}

/** Whether an error means the person's sign-in is gone for good (signed out everywhere, account disabled). */
export const signInGone = (e: unknown): boolean => e instanceof FirebaseAuthError && e.kind === 'revoked';
