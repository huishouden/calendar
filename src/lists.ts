import type { Doc } from '@huishouden/pwa-kit/firestore-rest';
import { sha256 } from './b64';
import type { Env } from './env';
import { log } from './log';
import { seal, unseal } from './seal';

/**
 * The lists a calendar is built from, kept between loads (D1 `lists`, sealed), so a sync or feed
 * build reads from Firestore only what changed since the last one.
 *
 * Without it every load read every document of the four lists: about 115 for a household with a
 * busy agenda, once per sync round and once per feed build, for each member, after every change
 * anyone made. Now a load asks each list's count and sum of `updatedAt` first (one aggregation, at
 * least one billed read) and then:
 *
 * - the same as the kept copy: the kept copy, nothing more read;
 * - different, for an unfiltered list (the shared lists of an admin or member): the documents with
 *   `updatedAt` after the newest kept, merged in. Kept only when the result's count and sum are
 *   the aggregation's, which a deletion never satisfies (the merged list still has the deleted
 *   document): then
 * - the whole list, as before (also for a filtered list: a helper's or kid's, a personal one).
 *
 * The same assumption as the change signal (src/person.ts): every write sets `updatedAt`. A copy is
 * read whole again once it is a day old (`LIST_MAX_AGE_MS`), which also repairs anything that
 * didn't. Each copy is keyed by its household, collection and query, so only people whose query is
 * the same share one (a helper's asks `private == false`; a personal list's names the member). Keys are hashes (no household id or
 * email in the table) and each copy is sealed for its key.
 */

/** A kept copy older than this is read whole again. */
export const LIST_MAX_AGE_MS = 24 * 3_600_000;
/** Copies not used for this long are deleted (src/tick.ts, hourly). */
export const LIST_FORGET_MS = 7 * 24 * 3_600_000;
/** D1 rows hold at most 2 MB; a bigger copy is not kept (the list is read whole each time). */
const MAX_SEALED = 1_500_000;

export type Tally = { count: number; sums: Record<string, number> };

/** What `aggregate(..., ['updatedAt'])` answers for these documents: how many, and the sum of their numeric `updatedAt`. */
export function tallyOf(docs: { data: Record<string, unknown> }[]): Tally {
  let sum = 0;
  for (const d of docs) if (typeof d.data.updatedAt === 'number') sum += d.data.updatedAt;
  return { count: docs.length, sums: { updatedAt: sum } };
}

const same = (a: Tally, b: Tally) => a.count === b.count && (a.sums.updatedAt ?? 0) === (b.sums.updatedAt ?? 0);

const newest = (docs: Doc[]) => docs.reduce((m, d) => (typeof d.data.updatedAt === 'number' && d.data.updatedAt > m ? d.data.updatedAt : m), 0);

interface Kept {
  docs: Doc[];
}

export interface ListReads {
  /** The list's count and sum of `updatedAt` now (one aggregation). */
  tally: () => Promise<Tally>;
  /** Every document of the list. */
  all: () => Promise<Doc[]>;
  /** The documents with `updatedAt` after `after`: only for a list read without filters. */
  since?: (after: number) => Promise<Doc[]>;
}

export type ListOutcome = 'kept' | 'delta' | 'full';

/** The key of a kept list: a hash of the household, the collection and whose view it is. */
export const listKey = (household: string, collection: string, query: string): Promise<string> => sha256(`list\u0000${household}\u0000${collection}\u0000${query}`);

/** The list's documents, from the kept copy where it is still right (see above). */
export async function readList(env: Env, key: string, reads: ListReads, now: number): Promise<{ docs: Doc[]; outcome: ListOutcome }> {
  const tally = await reads.tally();
  const read = (await readLists(env, [{ key, tally, reads }], now))!;
  // The copy is best-effort: D1 failing (its daily writes used up) costs reads, never the load.
  if (read.statements.length) await env.DB.batch(read.statements).catch(dbFailed);
  return { docs: read.docs[0], outcome: read.outcomes[0] };
}

const dbFailed = (e: unknown): null => {
  log('lists', { kept: false, reason: e instanceof Error ? e.name : 'unknown' });
  return null;
};

/** Deletes copies nobody has used for `LIST_FORGET_MS` (a member who left, a household gone). */
export async function forgetLists(env: Env, now: number): Promise<void> {
  await env.DB.prepare('DELETE FROM lists WHERE used_at < ?').bind(now - LIST_FORGET_MS).run();
}

/** A list to read in a round's unit (src/round.ts): its key, its aggregation already asked, how to read it. */
export interface ListPlan {
  key: string;
  tally: Tally;
  reads: ListReads;
}

/**
 * Lists whose aggregations were asked: every kept copy in one D1 read, then from Firestore only
 * what changed (the kept copy, what changed merged in, or the whole list: see above). The copies to
 * store (and the hourly `used_at`) come back as statements: `readList` runs them best-effort; a
 * round's unit (src/round.ts) runs them in its batch, so D1 refusing them fails the unit, which
 * runs again. `keptOnly`: null as soon as a copy doesn't match, nothing asked of Firestore.
 */
export async function readLists(env: Env, plans: ListPlan[], now: number, { keptOnly = false } = {}): Promise<{ docs: Doc[][]; outcomes: ListOutcome[]; statements: D1PreparedStatement[] } | null> {
  const statements: D1PreparedStatement[] = [];
  const rows = plans.length
    ? await env.DB.prepare(`SELECT key, body, at, used_at FROM lists WHERE key IN (${plans.map(() => '?').join(', ')})`)
        .bind(...plans.map((p) => p.key))
        .all<{ key: string; body: string; at: number; used_at: number }>()
        .then((r) => r.results)
        .catch((e: unknown) => dbFailed(e) ?? [])
    : [];
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const docs: Doc[][] = [];
  const outcomes: ListOutcome[] = [];
  for (const { key, tally, reads } of plans) {
    const row = byKey.get(key);
    const kept = row && now - row.at < LIST_MAX_AGE_MS && row.at <= now ? await unseal<Kept>(env.SEAL_KEY, `list:${key}`, row.body) : null;
    let found: { docs: Doc[]; outcome: ListOutcome } | null = null;
    if (kept && row) {
      if (same(tallyOf(kept.docs), tally)) {
        if (row.used_at < now - 3_600_000) statements.push(env.DB.prepare('UPDATE lists SET used_at = ?1 WHERE key = ?2').bind(now, key));
        found = { docs: kept.docs, outcome: 'kept' };
      } else if (reads.since) {
        const changed = await reads.since(newest(kept.docs));
        const merged = new Map(kept.docs.map((d) => [d.path, d]));
        for (const d of changed) merged.set(d.path, d);
        const all = [...merged.values()];
        if (same(tallyOf(all), tally)) {
          statements.push(await storeStatement(env, key, all, row.at, now));
          found = { docs: all, outcome: 'delta' };
        }
      }
    }
    // Only the kept copies (a round's later unit): one that changed means the round's lists did.
    if (!found && keptOnly) return null;
    if (!found) {
      const all = await reads.all();
      statements.push(await storeStatement(env, key, all, now, now));
      found = { docs: all, outcome: 'full' };
    }
    docs.push(found.docs);
    outcomes.push(found.outcome);
  }
  return { docs, outcomes, statements };
}

/** `write` as a statement: the copy stored, or (too big for a row) the old one deleted. */
async function storeStatement(env: Env, key: string, docs: Doc[], at: number, now: number): Promise<D1PreparedStatement> {
  const body = await seal(env.SEAL_KEY, `list:${key}`, { docs } satisfies Kept);
  if (body.length > MAX_SEALED) {
    log('lists', { kept: false, reason: 'too-big' });
    return env.DB.prepare('DELETE FROM lists WHERE key = ?').bind(key);
  }
  return env.DB.prepare('INSERT INTO lists (key, body, at, used_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(key) DO UPDATE SET body = excluded.body, at = excluded.at, used_at = excluded.used_at').bind(key, body, at, now);
}
