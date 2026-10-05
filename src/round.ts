import { contentHash, exportEvents, exportIcs, loadExportLang, toIcsEvents, visibleTo, type ExportEvent, type ExportInput } from '@huishouden/pwa-kit/calendar-export';
import { CRLF, foldLine, icsProblems, veventLines } from '@huishouden/pwa-kit/ics';
import type { AgendaItem } from '@huishouden/pwa-kit/agenda-core';
import type { TodoItem } from '@huishouden/pwa-kit/todo-core';
import type { Doc } from '@huishouden/pwa-kit/firestore-rest';
import { LocalClock } from '@huishouden/pwa-kit/local-clock';
import { globalFetch, type Env, type Fetch } from './env';
import { log } from './log';
import { loadedFrom, NotMember, Person, signalExtra, signalFrom, signInGone, zoneOf, type Loaded, type View } from './person';
import { readLists, type Tally } from './lists';
import type { HouseholdCounts } from './check';
import { seal, unseal } from './seal';
import { accessToken, GoogleAuthError } from './google/oauth';
import { Calendar, CalendarApiError, rateLimited, reasonOf, SyncTokenGone, type BatchRequest, type GoogleEvent } from './google/api';
import { applyEdit, dateFormatter, readChange, type Edit, type Written } from './backsync';
import { deleteEventRow, dropFeed, feedStatements, personRowStatement, putEventRow, savePerson, type EventRow, type PersonRecord, type PersonRow } from './store';
import { FULL_EVERY_MS, isEcho, MAX_WRITES, planWrites, type PlannedRequest, type PlannedRow, type SyncCounts } from './sync';

/**
 * A feed build or a sync round, in units small enough for the free plan's 10 ms of CPU each
 * (README, "CPU"). Each unit is its own invocation (src/work.ts); what the round has worked out so
 * far is kept on the person's row (`people.round`, sealed for `round:<pid>`), and what is too big
 * for it in `round_items`.
 *
 * A unit costs about 1 ms of CPU per subrequest (Firestore, Google, D1) besides its own work, so a
 * unit makes at most UNIT_CALLS of them and exports at most UNIT_ITEMS items. Its steps:
 *
 * - `google` (sync): one page of what changed in Google; echoes of our own writes dropped.
 * - `view`: the household and the person's settings in one request, and each list's count and sum
 *   of `updatedAt` (the change signal's aggregations).
 * - `view` uses the aggregations the check that found the change asked, when they are fresh.
 * - `lists`: every kept copy in one D1 read and from Firestore only what changed (src/lists.ts).
 * - `split`: the kept copies again, in one D1 read; the signal (a sync with nothing to do ends
 *   here); Google's changes carried back (then the lists again); the lists cut into parts.
 * - `export`, a part a unit: the part's events as iCalendar text (the feed, also in a sync round
 *   when the person has one) and as the writes for Google (sync).
 * - `feed`: the text put together, exactly as `exportIcs` writes it, and stored.
 * - `deletes` (sync): what is no longer in the calendar; then `write`, at most MAX_WRITES writes to
 *   Google a unit, deletions first. The last records the round.
 */

/** Items (agenda items and to-dos) one unit exports at most. */
export const UNIT_ITEMS = 60;
/** Subrequests (Firestore, Google, D1) one unit makes at most, besides its lease and its batch. */
export const UNIT_CALLS = 6;
/** A round not finished in this long starts again (what it planned is out of date). */
export const ROUND_MAX_MS = 30 * 60_000;
/** Writes (and rows) kept on the person's row while they are this few; more go to `round_items`. */
const ROW_WRITES = 20;

export type RoundKind = 1 | 2;
type Step = 'google' | 'view' | 'lists' | 'split' | 'export' | 'feed' | 'deletes' | 'write';

/** The most subrequests each step makes, for chaining steps within a unit. */
const STEP_CALLS: Record<Step, number> = { google: 3, view: 5, lists: 3, split: 5, export: 2, feed: 1, deletes: 1, write: 3 };

/** The next step's subrequests at most: `view` is one when the check's aggregations are fresh. */
const stepCalls = (ctx: Ctx): number => (ctx.state.step === 'view' && freshCounts(ctx) ? 1 : STEP_CALLS[ctx.state.step]);

interface PendingEdits {
  /** The Google event the edits came from (its id), and the key of the event it stands for. */
  gid: string;
  key: string;
  /** Deleted in Google (a whole event): an edit that can't be applied hides it rather than puts it back. */
  cancelled: boolean;
  edits: Edit[];
  next: number;
}

interface WriteItem {
  key: string;
  requests: PlannedRequest[];
  row: PlannedRow;
  /** The row as it was when planned: its etag and moved occurrences' etags carry over. */
  etag: string | null;
  overrides: string | null;
}

interface Piece {
  s: number;
  k: string;
  t: string;
}

export interface RoundState {
  kind: RoundKind;
  /** A sync round that builds the person's feed too (both were due): the same export. */
  feed: boolean;
  step: Step;
  started: number;
  view?: View;
  /** Each list's aggregation by slot; null: not read (the rules refused it, or to-dos are off). */
  tallies?: (Tally | null)[];
  reads: Record<string, string>;
  signal?: string;
  /** Sync: the token the listing started from (null: a full listing, whose items are ours). */
  fromToken?: string | null;
  pageToken?: string;
  nextSyncToken?: string;
  real: GoogleEvent[];
  editAt: number;
  pending?: PendingEdits;
  forced: string[];
  hide: string[];
  chunks: number;
  chunkAt: number;
  /** Sync: every key exported (what is not here is deleted). */
  wanted: string[];
  /** Sync: writes to make first (while they are few, all of them; Google's "too many" ones to try again). */
  writes: WriteItem[];
  /** Whether the writes went to `round_items` (too many for the row). */
  spilled: boolean;
  /** Segments handed on in `round_items`, by part, and the write groups made so far ('del' first). */
  segs: Record<Part, number>;
  delAt: number;
  writeAt: number;
  /** Whether the round put anything in `round_items` (removed when it ends). */
  items: boolean;
  /** Feed: the events that decide the calendar's header (the earliest year, a timed one). */
  witness: ExportEvent[];
  events: number;
  counts: SyncCounts;
}

export interface UnitResult {
  done: boolean;
  /** The steps the unit ran ("lists+split"), for the log. */
  step: string;
  /** Writes Google refused as too many: the person backs off (src/work.ts). */
  limited: boolean;
  /** What the unit writes to D1, run in one batch with the lease's release. */
  statements: D1PreparedStatement[];
  /** The round as it goes on the person's row (sealed), and when it started; null once it is done. */
  round: string | null;
  started: number;
  /** The work done once the round is: its kind, and the feed too when a sync built it. */
  finished: number;
  counts: SyncCounts;
  /** Subrequests the unit made (Firestore, Google, D1), for the log. */
  calls: number;
}

export interface RoundDeps {
  fetch?: Fetch;
  now?: number;
  firestoreUrl?: string;
  /** The round as the unit before handed it over (sealed), when it came straight from that unit. */
  round?: string | null;
}

export const zeroCounts = (): SyncCounts => ({ changes: 0, echoes: 0, applied: 0, refused: 0, conflicts: 0, hidden: 0, inserted: 0, updated: 0, deleted: 0, failed: 0, limited: 0, requests: 0, full: false, more: false });

const purpose = (pid: string) => `round:${pid}`;

function fresh(kind: RoundKind, now: number, row: PersonRow, record: PersonRecord): RoundState {
  return {
    kind,
    feed: kind === 2 && !!(row.work & 1) && !!record.feed && row.feed === 1,
    step: kind === 2 ? 'google' : 'view',
    started: now,
    reads: {},
    ...(kind === 2 ? { fromToken: row.sync_token } : {}),
    real: [],
    editAt: 0,
    forced: [],
    hide: [],
    chunks: 0,
    chunkAt: 0,
    wanted: [],
    writes: [],
    spilled: false,
    segs: { in: 0, ics: 0, del: 0, write: 0 },
    delAt: 0,
    writeAt: 0,
    items: false,
    witness: [],
    events: 0,
    counts: zeroCounts(),
  };
}

/** D1 with every call counted. */
function countedDb(db: D1Database, calls: { n: number }): D1Database {
  const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (prop === 'bind') return (...args: unknown[]) => wrap((v as (...a: unknown[]) => D1PreparedStatement).apply(target, args));
        if (prop === 'first' || prop === 'all' || prop === 'run' || prop === 'raw')
          return (...args: unknown[]) => {
            calls.n++;
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  return new Proxy(db, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql));
      if (prop === 'batch')
        return (statements: D1PreparedStatement[]) => {
          calls.n++;
          return target.batch(statements);
        };
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/** What one unit holds in memory from one step to the next (never kept). */
interface Memo {
  loaded?: Omit<Loaded, 'reads'>;
  part?: { agenda: AgendaItem[]; todos: TodoItem[] };
  pieces?: Piece[];
}

interface Ctx {
  env: Env;
  pid: string;
  row: PersonRow;
  record: PersonRecord;
  state: RoundState;
  now: number;
  fetch: Fetch;
  firestoreUrl?: string;
  statements: D1PreparedStatement[];
  calls: { n: number };
  limited: boolean;
  memo: Memo;
}

/** `continue`: on to the next step in this unit if it fits; `chain`: the next step runs in this unit (it needs the memo). */
type Next = 'continue' | 'chain' | 'yield' | 'done';

/**
 * The round to carry on: the one the unit before handed over (`given`), else the one on the
 * person's row; when it is of `kind` and not too old.
 */
export async function savedRound(env: Env, pid: string, row: PersonRow, kind: RoundKind, now: number, given?: string | null): Promise<RoundState | null> {
  const sealed = given ?? (row.round_kind === kind ? row.round : null);
  const state = sealed ? await unseal<RoundState>(env.SEAL_KEY, purpose(pid), sealed) : null;
  return state && state.kind === kind && state.started > now - ROUND_MAX_MS ? state : null;
}

/**
 * One unit of the person's round of `kind`, carrying on from the round on their row or starting
 * one. Reads go to D1 as it works; its writes come back as `statements` and `round` for the
 * caller's batch, so a unit that fails part way leaves the round where it was.
 */
export async function runUnit(env: Env, pid: string, kind: RoundKind, row: PersonRow, record: PersonRecord, deps: RoundDeps = {}): Promise<UnitResult> {
  const now = deps.now ?? Date.now();
  const calls = { n: 0 };
  const base = deps.fetch ?? globalFetch;
  const fetchImpl: Fetch = (url, init) => {
    calls.n++;
    return base(url, init);
  };
  const cenv: Env = { ...env, DB: countedDb(env.DB, calls) };
  const statements: D1PreparedStatement[] = [];
  let state = await savedRound(env, pid, row, kind, now, deps.round);
  if (!state) {
    // A new round: whatever an old one left goes.
    if (row.round || deps.round) statements.push(env.DB.prepare('DELETE FROM round_items WHERE pid = ?').bind(pid));
    state = fresh(kind, now, row, record);
  }
  const ctx: Ctx = { env: cenv, pid, row, record, state, now, fetch: fetchImpl, firestoreUrl: deps.firestoreUrl, statements, calls, limited: false, memo: {} };
  const ran: Step[] = [];
  let next: Next;
  for (;;) {
    ran.push(state.step);
    next = await STEPS[state.step](ctx);
    if (next === 'chain') continue;
    if (next !== 'continue' || ctx.limited || calls.n + stepCalls(ctx) > UNIT_CALLS) break;
  }
  const done = next === 'done';
  if (done && state.items) statements.push(env.DB.prepare('DELETE FROM round_items WHERE pid = ?').bind(pid));
  return {
    done,
    step: ran.join('+'),
    limited: ctx.limited,
    statements,
    round: done ? null : await seal(env.SEAL_KEY, purpose(pid), state),
    started: state.started,
    finished: done ? kind | (state.feed ? 1 : 0) : 0,
    counts: state.counts,
    calls: calls.n,
  };
}

const STEPS: Record<Step, (ctx: Ctx) => Promise<Next>> = {
  google: googleStep,
  view: viewStep,
  lists: listsStep,
  split: splitStep,
  export: exportStep,
  feed: feedStep,
  deletes: deletesStep,
  write: writeStep,
};

const person = (ctx: Ctx) => new Person(ctx.env, ctx.record, ctx.fetch, ctx.firestoreUrl);

const isSync = (ctx: Ctx) => ctx.state.kind === 2;
/** Whether the round builds the feed: a feed round, or a sync round that does both. */
const buildsFeed = (ctx: Ctx) => !isSync(ctx) || ctx.state.feed;

/** The round ends with a line for the portal (sync), nothing else changed. */
function syncEnds(ctx: Ctx, fields: Partial<Omit<PersonRow, 'pid' | 'created_at' | 'shard'>>): Next {
  ctx.statements.push(personRowStatement(ctx.env, ctx.pid, { last_sync: ctx.now, ...fields }, ctx.now));
  return 'done';
}

type Part = 'in' | 'ics' | 'del' | 'write';

/**
 * Hands `value` to a later unit: sealed, appended to the part's one row in `round_items` (a row a
 * part, not a row a value: rows written are a free-plan limit). Its index in the part comes back.
 */
async function handOn(ctx: Ctx, part: Part, value: unknown): Promise<number> {
  const body = await seal(ctx.env.SEAL_KEY, purpose(ctx.pid), value);
  const index = ctx.state.segs[part]++;
  // Appended only as the index-th value: a unit run again (its invocation lost after its writes)
  // can't add a value twice.
  ctx.statements.push(
    index === 0
      ? ctx.env.DB.prepare('INSERT INTO round_items (pid, part, seq, body) VALUES (?, ?, 0, ?) ON CONFLICT(pid, part, seq) DO NOTHING').bind(ctx.pid, part, body)
      : ctx.env.DB.prepare("UPDATE round_items SET body = body || char(10) || ?1 WHERE pid = ?2 AND part = ?3 AND seq = 0 AND length(body) - length(replace(body, char(10), '')) = ?4").bind(body, ctx.pid, part, index - 1),
  );
  ctx.state.items = true;
  return index;
}

/** The values handed on in `part`, still sealed, in order (one D1 read). */
async function handedOn(ctx: Ctx, part: Part): Promise<string[]> {
  const row = await ctx.env.DB.prepare('SELECT body FROM round_items WHERE pid = ? AND part = ? AND seq = 0').bind(ctx.pid, part).first<{ body: string }>();
  return row ? row.body.split('\n') : [];
}

const opened = <T>(ctx: Ctx, sealed: string | undefined): Promise<T | null> => unseal<T>(ctx.env.SEAL_KEY, purpose(ctx.pid), sealed ?? null);

/** The round from the top: something it handed on is gone (another round replaced it). */
function restart(ctx: Ctx): Next {
  Object.assign(ctx.state, fresh(ctx.state.kind, ctx.now, ctx.row, ctx.record));
  ctx.statements.push(ctx.env.DB.prepare('DELETE FROM round_items WHERE pid = ?').bind(ctx.pid));
  return 'yield';
}

// ---- google: what changed in the person's Google calendar ----

async function googleStep(ctx: Ctx): Promise<Next> {
  const { state, record, env, pid, now } = ctx;
  const google = record.google!;
  let calendar: Calendar;
  try {
    calendar = new Calendar(await accessToken(env, google.refreshToken, ctx.fetch, now), ctx.fetch);
  } catch (e) {
    if (e instanceof GoogleAuthError && e.kind === 'revoked') return syncEnds(ctx, { last_error: 'google-revoked' });
    throw e;
  }
  let page: Awaited<ReturnType<Calendar['changesPage']>>;
  try {
    page = await calendar.changesPage(google.calendarId, state.fromToken ?? null, state.pageToken);
  } catch (e) {
    if (e instanceof SyncTokenGone) {
      state.fromToken = null;
      state.pageToken = undefined;
      return 'yield';
    }
    if (e instanceof CalendarApiError && e.status === 404) {
      // They deleted the Huishouden calendar in Google: stop syncing until they connect again.
      await savePerson(env, pid, { ...record, google: undefined });
      ctx.statements.push(env.DB.prepare('DELETE FROM events WHERE pid = ?').bind(pid));
      return syncEnds(ctx, { google: 0, last_error: 'calendar-deleted', sync_token: null });
    }
    throw e;
  }
  state.counts.requests += 1;
  state.counts.changes += page.items.length;
  // A first full listing (no sync token) is our own events as they are, not changes.
  if (state.fromToken && page.items.length) {
    const { results } = await env.DB.prepare('SELECT event_id, etag, overrides FROM events WHERE pid = ?').bind(pid).all<Pick<EventRow, 'event_id' | 'etag' | 'overrides'>>();
    const byId = new Map(results.map((r) => [r.event_id, r as EventRow]));
    const real = page.items.filter((g) => !isEcho(g, byId.get(g.recurringEventId ?? g.id)));
    state.counts.echoes += page.items.length - real.length;
    state.real.push(...real);
  }
  if (page.nextPageToken) {
    state.pageToken = page.nextPageToken;
    return 'yield';
  }
  state.pageToken = undefined;
  state.nextSyncToken = page.nextSyncToken;
  state.step = 'view';
  // A long page (a first listing) was work enough for one unit.
  return page.items.length > 20 ? 'yield' : 'continue';
}

// ---- view, lists: the person's view and lists ----

/** The check's aggregations are used for a round that starts within this long of them. */
export const COUNTS_MAX_MS = 10 * 60_000;

async function viewStep(ctx: Ctx): Promise<Next> {
  const { state } = ctx;
  const p = person(ctx);
  try {
    state.view = await p.view();
  } catch (e) {
    return viewFailed(ctx, e);
  }
  const view = state.view;
  const specs = p.listSpecs(view);
  // The check that found the change asked these moments ago, for the same view: not again.
  const checked = freshCounts(ctx);
  if (checked && checked.restricted === view.restricted && checked.todos === view.settings.todos) {
    state.tallies = checked.counts;
    state.step = 'lists';
    // The lists (and the split with them) are a unit's work of their own.
    return 'yield';
  }
  const counted = await Promise.all(specs.map((s) => p.countOf(s)));
  state.tallies = [null, null, null, null];
  specs.forEach((s, i) => (state.tallies![s.slot] = counted[i]));
  state.step = 'lists';
  return 'yield';
}

/** The check's aggregations on the person's row, when they are recent and nothing has changed the records since. */
function freshCounts(ctx: Ctx): HouseholdCounts | null {
  const c = parseCounts(ctx.row.hh_counts);
  return c && ctx.now - c.at < COUNTS_MAX_MS && c.at <= ctx.now && ctx.state.counts.applied === 0 ? c : null;
}

function parseCounts(text: string | null): HouseholdCounts | null {
  try {
    const c = text ? (JSON.parse(text) as HouseholdCounts) : null;
    return c && Array.isArray(c.counts) && c.counts.length === 4 ? c : null;
  } catch {
    return null;
  }
}

async function viewFailed(ctx: Ctx, e: unknown): Promise<Next> {
  const { env, pid, record } = ctx;
  if (e instanceof NotMember) {
    if (isSync(ctx)) return syncEnds(ctx, { last_error: 'not-member' });
    await dropFeed(env, pid, ctx.now);
    return 'done';
  }
  if (signInGone(e)) {
    await savePerson(env, pid, { ...record, signedOut: true });
    if (isSync(ctx)) return syncEnds(ctx, { last_error: 'signed-out' });
    log('feed', { built: false, reason: 'signed-out' });
    return 'done';
  }
  throw e;
}

async function listsStep(ctx: Ctx): Promise<Next> {
  const { state } = ctx;
  const read = (await loadLists(ctx))!;
  read.specs.forEach((s, i) => (state.reads[s.collection] = read.outcomes[i]));
  state.step = 'split';
  // Small lists all as kept: the split in this unit. Otherwise reading (and keeping) them was a
  // unit's work: the split reads the kept copies in the next.
  const docs = read.docs.reduce((n, d) => n + d.length, 0);
  if (docs <= UNIT_ITEMS && read.outcomes.every((o) => o === 'kept')) return 'chain';
  ctx.memo.loaded = undefined;
  return 'yield';
}

/**
 * The person's lists by the aggregations the `view` step asked (src/lists.ts `readLists`), into the
 * memo. `keptOnly`: from the kept copies alone, null when one no longer matches.
 */
async function loadLists(ctx: Ctx, keptOnly = false) {
  const { state, now } = ctx;
  const p = person(ctx);
  const specs = p.listSpecs(state.view!).filter((s) => state.tallies![s.slot]);
  const plans = await Promise.all(specs.map(async (s) => ({ key: await p.listKeyOf(s), tally: state.tallies![s.slot]!, reads: p.asks(s) })));
  const read = await readLists(ctx.env, plans, now, { keptOnly });
  if (!read) return null;
  ctx.statements.push(...read.statements);
  const docs: Doc[][] = [[], [], [], []];
  specs.forEach((s, i) => (docs[s.slot] = read.docs[i]));
  ctx.memo.loaded = loadedFrom(docs);
  return { ...read, specs };
}

const exportInput = (ctx: Ctx): Omit<ExportInput, 'agenda' | 'todos'> => {
  const view = ctx.state.view!;
  return { me: ctx.record.email, role: view.role, lang: ctx.record.lang, timeZone: zoneOf(view, ctx.record), settings: view.settings, home: view.home?.address };
};

/**
 * The lists cut into parts for the export, each at most `size` items (an app record's items stay
 * together: a series is one event), without what the person doesn't see, as even as that allows.
 * Exporting each part and sorting the events together gives exactly `exportEvents` of the whole.
 */
export function partition(loaded: Pick<Loaded, 'agenda' | 'todos'>, input: Pick<ExportInput, 'me' | 'role' | 'settings'>, size = UNIT_ITEMS): { agenda: AgendaItem[]; todos: TodoItem[] }[] {
  const groups = new Map<string, AgendaItem[]>();
  for (const item of loaded.agenda) {
    if (!visibleTo(item, input)) continue;
    const k = `${item.app}|${item.ref}`;
    const g = groups.get(k);
    if (g) g.push(item);
    else groups.set(k, [item]);
  }
  const todos = input.settings.todos
    ? (loaded.todos ?? []).filter((t) => t.status === 'open' && t.due !== undefined && !groups.has(`${t.app}|${t.ref}`) && visibleTo({ app: t.app, kind: 'task', private: t.private, audience: t.audience }, input))
    : [];
  const total = [...groups.values()].reduce((n, g) => n + g.length, 0) + todos.length;
  // As even as the size allows: 63 items go as 32 and 31, not 50 and 13.
  const even = Math.ceil(total / Math.max(1, Math.ceil(total / size)));
  const parts: { agenda: AgendaItem[]; todos: TodoItem[] }[] = [];
  let current = { agenda: [] as AgendaItem[], todos: [] as TodoItem[] };
  const add = (n: number) => {
    const has = current.agenda.length + current.todos.length;
    if (has > 0 && has + n > even) {
      parts.push(current);
      current = { agenda: [], todos: [] };
    }
  };
  for (const items of groups.values()) {
    add(items.length);
    current.agenda.push(...items);
  }
  for (const t of todos) {
    add(1);
    current.todos.push(t);
  }
  if (current.agenda.length + current.todos.length) parts.push(current);
  return parts;
}

// ---- split: the signal, Google's changes carried back, the parts ----

async function splitStep(ctx: Ctx): Promise<Next> {
  const { state, row, record, env, pid, now } = ctx;
  const view = state.view!;
  // The copies the `lists` step kept; one that changed since (another member's round kept newer
  // lists): the lists again.
  if (!ctx.memo.loaded && !(await loadLists(ctx, true))) {
    state.step = 'lists';
    return 'yield';
  }
  const loaded = ctx.memo.loaded!;
  state.signal = signalFrom(view, loaded.tally, signalExtra(view, record));
  if (isSync(ctx) && !state.feed && state.editAt === 0 && !state.pending && state.counts.applied === 0 && state.real.length === 0) {
    const any = await env.DB.prepare('SELECT 1 AS x FROM events WHERE pid = ? LIMIT 1').bind(pid).first<{ x: number }>();
    const full = !row.full_at || now - row.full_at > FULL_EVERY_MS || !any;
    if (state.signal === row.signal && !full) {
      const token = state.nextSyncToken && state.nextSyncToken !== row.sync_token && state.counts.changes > 0 ? { sync_token: state.nextSyncToken } : {};
      return syncEnds(ctx, { last_ok: now, last_error: null, ...token });
    }
  }
  if (isSync(ctx)) state.counts.full = true;
  await loadExportLang(record.lang);
  if (isSync(ctx) && (state.pending || state.editAt < state.real.length)) {
    // Google's changes carried back (an edit at most); then the lists again, as they are now.
    await carryBack(ctx, loaded);
    state.step = 'view';
    return 'yield';
  }
  const parts = partition(loaded, exportInput(ctx));
  state.chunks = parts.length;
  state.chunkAt = 0;
  if (parts.length === 0) {
    state.step = isSync(ctx) ? 'deletes' : 'feed';
    if (!isSync(ctx)) ctx.memo.pieces = [];
    return 'chain';
  }
  state.step = 'export';
  if (parts.length === 1) {
    // One part: exported in this unit.
    ctx.memo.part = parts[0];
    return 'chain';
  }
  // Several: handed to the export's units, a part each.
  for (const p of parts) await handOn(ctx, 'in', p);
  return 'yield';
}

/**
 * Google's changes, carried back to the records (src/backsync.ts) until one edit is applied (the
 * records changed) or none is left. What can't be applied is put back or hidden.
 */
async function carryBack(ctx: Ctx, loaded: Omit<Loaded, 'reads'>): Promise<void> {
  const { state, record, env, pid, now } = ctx;
  const view = state.view!;
  const tz = zoneOf(view, record);
  const p = person(ctx);
  const { results } = await env.DB.prepare('SELECT * FROM events WHERE pid = ?').bind(pid).all<EventRow>();
  const byId = new Map(results.map((r) => [r.event_id, r]));
  const events = exportEvents({ ...exportInput(ctx), agenda: loaded.agenda, todos: loaded.todos });
  const format = dateFormatter(record.lang, tz);
  const clock = new LocalClock(tz, () => now);
  const forced = new Set(state.forced);
  const hide = new Set(state.hide);
  const keep = () => {
    state.forced = [...forced];
    state.hide = [...hide];
  };
  for (;;) {
    if (!state.pending) {
      if (state.editAt >= state.real.length) break;
      const g = state.real[state.editAt++];
      const r = byId.get(g.recurringEventId ?? g.id);
      if (!r) continue;
      const reading = readChange(g, writtenOf(r), events.find((e) => e.key === r.key), tz, format);
      if ('ignore' in reading) continue;
      if ('revert' in reading) {
        forced.add(r.key);
        continue;
      }
      state.pending = { gid: g.id, key: r.key, cancelled: g.status === 'cancelled' && !g.recurringEventId, edits: reading.edits, next: 0 };
    }
    const pending = state.pending;
    while (pending.next < pending.edits.length) {
      const found = pending.edits[pending.next++];
      if (found.kind === 'hide') {
        hide.add(pending.key);
        state.counts.hidden++;
        continue;
      }
      // Each edit acts on the records as they are now: an earlier one may have just changed them.
      const items = loaded.agenda.filter((i: AgendaItem) => i.app === found.item.app && i.ref === found.item.ref);
      const current = items.find((i) => i.id === found.item.id) ?? items.find((i) => i.series && i.series.original === found.item.series?.original) ?? items[0];
      if (!current) continue;
      const outcome = await applyEdit({ ...found, item: current, gid: pending.gid }, { person: p, view, today: clock.today(), now, timeZone: tz, items });
      if (outcome === 'applied' || outcome === 'already') {
        state.counts.applied++;
        if (pending.next >= pending.edits.length) state.pending = undefined;
        keep();
        return;
      }
      if (outcome === 'conflict') {
        state.counts.conflicts++;
        forced.add(pending.key);
      } else {
        state.counts.refused++;
        // Something they may not change (or that is gone): out of their calendar if they deleted
        // it, put back as it is otherwise.
        if (pending.cancelled) hide.add(pending.key);
        else forced.add(pending.key);
      }
    }
    state.pending = undefined;
  }
  keep();
}

const writtenOf = (r: EventRow): Written | undefined => {
  try {
    return r.written ? (JSON.parse(r.written) as Written) : undefined;
  } catch {
    return undefined;
  }
};

// ---- export: one part's events ----

/** One event's VEVENTs (the event, and a series' moved occurrences) as the feed writes them. */
export function eventIcs(e: ExportEvent, { householdId, timeZone, lang, now }: { householdId: string; timeZone: string; lang: ExportInput['lang']; now: number }): string {
  return toIcsEvents([e], { householdId, timeZone, lang }).flatMap((ie) => veventLines(ie, { timeZone, now })).map(foldLine).join(CRLF) + CRLF;
}

const bare = (e: ExportEvent): ExportEvent => {
  const { todo: _t, ...rest } = e;
  return { ...rest, items: [], ...(e.series ? { series: { ...e.series, overrides: e.series.overrides.map((o) => ({ ...o, items: [] })) } } : {}) };
};

/** The earliest year any of the event's VEVENTs touches, and whether any has a time. */
function yearOf(e: ExportEvent, householdId: string, timeZone: string, lang: ExportInput['lang']): { year: number; timed: boolean } {
  let year = Infinity;
  let timed = false;
  for (const ie of toIcsEvents([e], { householdId, timeZone, lang })) {
    const t = 'date' in ie.start ? Date.parse(`${ie.start.date}T00:00:00Z`) : ie.start.at;
    year = Math.min(year, new Date(t).getUTCFullYear());
    if (!('date' in ie.start)) timed = true;
  }
  return { year, timed };
}

/** Keeps, of `witness` and `events`, the ones that decide the header: the earliest year, and one with a time. */
export function keepWitness(witness: ExportEvent[], events: readonly ExportEvent[], householdId: string, timeZone: string, lang: ExportInput['lang']): ExportEvent[] {
  let earliest: { e: ExportEvent; year: number } | null = null;
  let timed: ExportEvent | null = null;
  for (const e of [...witness, ...events]) {
    const y = yearOf(e, householdId, timeZone, lang);
    if (!earliest || y.year < earliest.year) earliest = { e, year: y.year };
    if (!timed && y.timed) timed = e;
  }
  return [...new Set([earliest?.e, timed].filter((e): e is ExportEvent => !!e))].map(bare);
}

/**
 * The header `exportIcs` writes for the calendar (the time zone when any event has a time, from
 * the earliest year any event touches), cut from the calendar of the events that decide it.
 */
export function icsHeader(witness: readonly ExportEvent[], options: Parameters<typeof exportIcs>[1]): string {
  const text = exportIcs(witness, options);
  const at = text.indexOf(`BEGIN:VEVENT${CRLF}`);
  return text.slice(0, at >= 0 ? at : text.lastIndexOf(`END:VCALENDAR${CRLF}`));
}

/** The calendar from its events' text (any order) and the header's events: `exportIcs` of them all. */
export function assembleIcs(pieces: readonly Piece[], witness: readonly ExportEvent[], options: Parameters<typeof exportIcs>[1]): string {
  const sorted = [...pieces].sort((a, b) => a.s - b.s || a.k.localeCompare(b.k));
  return icsHeader(witness, options) + sorted.map((p) => p.t).join('') + `END:VCALENDAR${CRLF}`;
}

async function exportStep(ctx: Ctx): Promise<Next> {
  const { state, record, env, pid } = ctx;
  const tz = zoneOf(state.view!, record);
  const at = state.chunkAt;
  let part = ctx.memo.part;
  ctx.memo.part = undefined;
  if (!part) {
    part = (await opened<{ agenda: AgendaItem[]; todos: TodoItem[] }>(ctx, (await handedOn(ctx, 'in'))[at])) ?? undefined;
    if (!part) return restart(ctx);
  }
  await loadExportLang(record.lang);
  const events = exportEvents({ ...exportInput(ctx), agenda: part.agenda, todos: part.todos });
  state.events += events.length;
  if (buildsFeed(ctx)) {
    const options = { householdId: record.household, timeZone: tz, lang: record.lang, now: state.started };
    const pieces = events.map((e) => ({ s: e.start, k: e.key, t: eventIcs(e, options) }));
    state.witness = keepWitness(state.witness, events, record.household, tz, record.lang);
    // One part: the feed is put together in this unit. Several: in a unit of its own.
    if (state.chunks === 1) ctx.memo.pieces = pieces;
    else await handOn(ctx, 'ics', pieces);
  }
  if (isSync(ctx)) {
    const keys = events.map((e) => e.key);
    state.wanted.push(...keys);
    const rows: EventRow[] = [];
    // D1 binds at most 100 values a statement.
    for (let i = 0; i < keys.length; i += 90) {
      const slice = keys.slice(i, i + 90);
      const { results } = await env.DB.prepare(`SELECT * FROM events WHERE pid = ? AND key IN (${slice.map(() => '?').join(', ')})`)
        .bind(pid, ...slice)
        .all<EventRow>();
      rows.push(...results);
    }
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const hide = new Set(state.hide);
    const plan = await planWrites(pid, events, rows, { householdId: record.household, timeZone: tz, calendarId: record.google!.calendarId, forced: new Set(state.forced), hide });
    const items: WriteItem[] = [];
    for (const next of plan.rows) {
      const requests = plan.requests.filter((r) => r.key === next.key);
      if (!requests.length && !hide.has(next.key)) continue;
      items.push({ key: next.key, requests, row: next, etag: byKey.get(next.key)?.etag ?? null, overrides: byKey.get(next.key)?.overrides ?? null });
    }
    await queueWrites(ctx, items, false);
  }
  state.chunkAt++;
  if (state.chunkAt < state.chunks) return 'yield';
  state.step = buildsFeed(ctx) ? 'feed' : 'deletes';
  // One part (a small calendar): the rest in this unit. Several: the next unit.
  if (state.chunks > 1) return 'yield';
  return buildsFeed(ctx) ? 'chain' : 'continue';
}

/**
 * Writes for Google, kept on the row while they are few; beyond, in `round_items`, a row per write
 * unit (at most MAX_WRITES writes, a key's writes together), deletions first.
 */
async function queueWrites(ctx: Ctx, items: WriteItem[], deletions: boolean): Promise<void> {
  const { state } = ctx;
  if (!state.spilled) {
    const all = deletions ? [...items, ...state.writes] : [...state.writes, ...items];
    if (all.reduce((n, i) => n + i.requests.length + 1, 0) <= ROW_WRITES) {
      state.writes = all;
      return;
    }
    // Too many for the row: what is on it goes to `round_items` too, in order.
    const moving = state.writes;
    state.writes = [];
    state.spilled = true;
    for (const group of unitsOf(moving)) await handOn(ctx, 'write', group);
  }
  for (const group of unitsOf(items)) await handOn(ctx, deletions ? 'del' : 'write', group);
}

/** Write items in groups of at most MAX_WRITES writes (a key's writes together; a key with more alone). */
function unitsOf(items: WriteItem[]): WriteItem[][] {
  const groups: WriteItem[][] = [];
  let current: WriteItem[] = [];
  let n = 0;
  for (const item of items) {
    if (current.length && n + item.requests.length > MAX_WRITES) {
      groups.push(current);
      current = [];
      n = 0;
    }
    current.push(item);
    n += item.requests.length;
  }
  if (current.length) groups.push(current);
  return groups;
}

// ---- feed: the calendar put together ----

async function feedStep(ctx: Ctx): Promise<Next> {
  const { state, record, env, pid } = ctx;
  if (record.feed) {
    const tz = zoneOf(state.view!, record);
    // One part's text is in memory (`exportStep`); several parts' in D1.
    const pieces = [...(ctx.memo.pieces ?? [])];
    ctx.memo.pieces = undefined;
    if (state.chunks > 1) {
      for (const sealed of await handedOn(ctx, 'ics')) pieces.push(...((await opened<Piece[]>(ctx, sealed)) ?? []));
    }
    // A part went missing: start again rather than serve a calendar without it.
    if (pieces.length !== state.events) return restart(ctx);
    const body = assembleIcs(pieces, state.witness, { householdId: record.household, timeZone: tz, lang: record.lang, now: state.started });
    ctx.statements.push(...(await feedStatements(env, pid, record.feed.secret, { signal: state.signal!, etag: `"${contentHash(body)}"`, body, now: ctx.now })));
    log('feed', { built: true, events: state.events, problems: icsProblems(body).length, lists: Object.entries(state.reads).map(([c, o]) => `${c}:${o}`).join(' ') });
  }
  if (!isSync(ctx)) return 'done';
  state.step = 'deletes';
  return state.chunks > 1 ? 'yield' : 'continue';
}

// ---- deletes and write: Google's calendar made to match ----

async function deletesStep(ctx: Ctx): Promise<Next> {
  const { state, record, env, pid } = ctx;
  const cal = `/calendars/${encodeURIComponent(record.google!.calendarId)}/events`;
  const wanted = new Set(state.wanted);
  const { results } = await env.DB.prepare('SELECT key, event_id, hash, hidden FROM events WHERE pid = ?').bind(pid).all<Pick<EventRow, 'key' | 'event_id' | 'hash' | 'hidden'>>();
  const items: WriteItem[] = results
    .filter((row) => !wanted.has(row.key))
    .map((row) => ({
      key: row.key,
      requests: row.hidden ? [] : [{ kind: 'delete' as const, key: row.key, eventId: row.event_id, request: { method: 'DELETE' as const, path: `${cal}/${row.event_id}` } }],
      row: { key: row.key, eventId: row.event_id, hash: row.hash, written: null, overrides: [], hidden: !!row.hidden, deleted: true },
      etag: null,
      overrides: null,
    }));
  state.wanted = [];
  await queueWrites(ctx, items, true);
  state.step = 'write';
  if (!state.spilled && !state.writes.length) return finishSync(ctx);
  // Writes on the row can go in this unit; handed on in `round_items`, the next.
  return state.spilled ? 'yield' : 'continue';
}

const parseOverrides = (s: string | null): { original: string; etag: string | null }[] => {
  try {
    return s ? (JSON.parse(s) as { original: string; etag: string | null }[]) : [];
  } catch {
    return [];
  }
};

async function writeStep(ctx: Ctx): Promise<Next> {
  const { state, record, env, pid, now } = ctx;
  const google = record.google!;
  // The writes on the row first (few, or Google's "too many" ones again); then the next group
  // handed on, deletions first.
  let group: WriteItem[];
  const fromRow = state.writes.length > 0;
  if (fromRow) group = unitsOf(state.writes)[0];
  else if (state.delAt < state.segs.del) group = (await opened<WriteItem[]>(ctx, (await handedOn(ctx, 'del'))[state.delAt++])) ?? [];
  else if (state.writeAt < state.segs.write) group = (await opened<WriteItem[]>(ctx, (await handedOn(ctx, 'write'))[state.writeAt++])) ?? [];
  else return finishSync(ctx);
  const picked = group.map((item, i) => ({ seq: i, item }));
  const requests = picked.flatMap((p) => p.item.requests);
  let responses: { status: number; body: unknown }[] = [];
  if (requests.length) {
    const calendar = new Calendar(await accessToken(env, google.refreshToken, ctx.fetch, now), ctx.fetch);
    responses = await calendar.batch(requests.map((p) => p.request));
    const retry: BatchRequest[] = [];
    const retryOf: number[] = [];
    responses.forEach((res, i) => {
      const p = requests[i];
      // Inserting an id Google has seen before (deleted, or written by a run that didn't finish): update it instead.
      if (p.kind === 'insert' && res.status === 409) {
        retry.push({ method: 'PUT', path: `/calendars/${encodeURIComponent(google.calendarId)}/events/${p.eventId}`, body: p.request.body });
        retryOf.push(i);
      }
    });
    const retried = await calendar.batch(retry);
    retried.forEach((res, j) => (responses[retryOf[j]] = res));
    state.counts.requests += calendar.requests;
  }
  let at = 0;
  const done = new Set<number>();
  for (const { seq, item } of picked) {
    const answers = responses.slice(at, at + item.requests.length);
    at += item.requests.length;
    const etags = new Map<string, string | null>();
    let failed = 0;
    let limited = 0;
    answers.forEach((res, i) => {
      const p = item.requests[i];
      const ok = res.status >= 200 && res.status < 300;
      const gone = p.kind === 'delete' && (res.status === 404 || res.status === 410);
      if (!ok && !gone) {
        failed++;
        if (rateLimited(res.status, reasonOf(res.body))) limited++;
        return;
      }
      if (p.kind === 'insert') state.counts.inserted++;
      else if (p.kind === 'update') state.counts.updated++;
      else if (p.kind === 'delete') state.counts.deleted++;
      const body = res.body as { etag?: unknown } | null;
      etags.set(`${p.key}|${p.original ?? ''}`, typeof body?.etag === 'string' ? body.etag : null);
    });
    if (limited) {
      // Too many requests: the key stays for the unit after the back-off.
      state.counts.limited += limited;
      ctx.limited = true;
      continue;
    }
    done.add(seq);
    if (failed) {
      state.counts.failed += failed;
      continue;
    }
    const next = item.row;
    if (next.deleted) {
      ctx.statements.push(deleteEventRow(env, pid, next.key));
      continue;
    }
    const master = etags.get(`${next.key}|`);
    const overrides = next.overrides.map((o) => ({ original: o, etag: etags.get(`${next.key}|${o}`) ?? parseOverrides(item.overrides).find((x) => x.original === o)?.etag ?? null }));
    ctx.statements.push(
      putEventRow(env, {
        pid,
        key: next.key,
        event_id: next.eventId,
        hash: next.hash,
        etag: master !== undefined ? master : item.etag,
        overrides: JSON.stringify(overrides),
        written: next.written,
        hidden: next.hidden ? 1 : 0,
      }),
    );
  }
  const left = group.filter((_, i) => !done.has(i));
  // Google's "too many" ones stay on the row, first for the unit after the back-off.
  state.writes = fromRow ? [...left, ...state.writes.slice(group.length)] : left;
  const more = state.writes.length > 0 || state.delAt < state.segs.del || state.writeAt < state.segs.write;
  return more ? 'yield' : finishSync(ctx);
}

/** The round recorded: the signal it reached (unless a write failed), the sync token, the counts. */
function finishSync(ctx: Ctx): Next {
  const { state, row, now } = ctx;
  const c = state.counts;
  const ok = c.failed === 0;
  return syncEnds(ctx, {
    ...(ok ? { last_ok: now, last_error: null } : { last_error: 'google-write' }),
    signal: ok ? state.signal! : null,
    full_at: ok ? now : row.full_at,
    ...(state.nextSyncToken ? { sync_token: state.nextSyncToken } : {}),
    notice: c.refused ? `refused:${c.refused}` : row.notice,
    counts: JSON.stringify({ applied: c.applied, refused: c.refused, inserted: c.inserted, updated: c.updated, deleted: c.deleted, events: state.events }),
  });
}
