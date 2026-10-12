import { budgetScopeOf, d1Ledger, FIRESTORE_PAUSE_MS, quotaDay, readCap, ReadBudget, untilNextQuotaDay } from '@huishouden/pwa-kit/read-budget';
import { FirestoreError } from '@huishouden/pwa-kit/firestore-rest';
import type { Env } from './env';
import { log } from './log';

/**
 * The Firestore reads this Worker may use, on the kit's `ReadBudget` (pwa-kit STANDARD.md "Read
 * budgets"). The free plan's 50,000 reads a day are the whole project's, every app's included, and
 * once they are gone every app's reads fail until midnight Pacific. Each kind of run draws on its
 * own share of the day, counted in D1 (`meta`, a row per share and Pacific day: `check-reads:…`,
 * `work-reads:…`, `mail-reads:…`), and has a cap of its own:
 *
 * | Run | Share (wrangler.toml) | Cap per run |
 * |---|---|---|
 * | a check invocation (src/check.ts) | `FIRESTORE_CHECK_READS` | CHECK_READS |
 * | a unit of a feed or sync round (src/work.ts) | `FIRESTORE_WORK_READS` | ROUND_READS, and the round as a whole after each step (src/round.ts) |
 * | a unit of an alert inbox (src/mail/work.ts) | `FIRESTORE_MAIL_READS` | MAIL_READS |
 *
 * Every Firestore call a `Person` makes goes through its budget's `fetch`, which counts what each
 * answer is billed for and refuses past a cap with Firestore's own quota answer. A real 429 from
 * Firestore pauses checks and work for FIRESTORE_PAUSE_MS (`firestore-pause`). The person's last
 * round's reads are on their row (`people.round_reads`); the logs carry counts only.
 */

export { FIRESTORE_PAUSE_MS, quotaDay };

/**
 * Firestore reads one round may be billed for, 5% of the free plan's 50,000 a day. A busy
 * household's first build reads its four lists whole (a few hundred documents).
 */
export const ROUND_READS = 2_500;

/** Firestore reads one check invocation (a household's members, src/check.ts) may be billed for: about 6 a person. */
export const CHECK_READS = 300;

/** Firestore reads one unit of an alert inbox may be billed for: cards, rules, settings and a few days of transactions. */
export const MAIL_READS = 400;

/** Firestore reads one portal request may be billed for (a member's own action: their household, an inbox, an import). */
export const REQUEST_READS = 200;

/** A person whose round went past ROUND_READS waits this long before the next. */
export const READ_BACKOFF_MS = 60 * 60_000;

/** Whether a round billed `reads` so far is past ROUND_READS. */
export const roundOverBudget = (reads: number): boolean => reads > ROUND_READS;

/** The round went past ROUND_READS: it is dropped. */
export class ReadBudgetSpent extends Error {
  constructor(readonly reads: number) {
    super(`round read budget spent: ${reads} reads`);
    this.name = 'ReadBudgetSpent';
  }
}

/** The day's counts and the pause, in D1's `meta`. */
export const ledger = (env: Pick<Env, 'DB'>) => d1Ledger(env.DB);

/** Each kind of run: its cap, and the variable of its share of the day. */
const SHARES = {
  check: { cap: CHECK_READS, variable: 'FIRESTORE_CHECK_READS' },
  work: { cap: ROUND_READS, variable: 'FIRESTORE_WORK_READS' },
  mail: { cap: MAIL_READS, variable: 'FIRESTORE_MAIL_READS' },
} as const;

export type Share = keyof typeof SHARES;

/** A run's budget: its cap, its share of the day, the ledger, the pause. */
export function runBudget(env: Env, share: Share, now: number): ReadBudget {
  const { cap, variable } = SHARES[share];
  return new ReadBudget({
    run: cap,
    daily: [{ name: share, cap: readCap(variable, env[variable]) }],
    ledger: ledger(env),
    now: () => now,
    onLedgerError: () => log('budget', { share, ok: false, reason: 'ledger' }),
  });
}

/** What refused a run: its own cap (`run`) or its share of the day. */
export type Refusal = Share | 'run';

/** The budget that refused (`run`, or a share's name), or null: anything else, Firestore's own quota included. */
export function refusedBy(e: unknown): Refusal | null {
  const scope = budgetScopeOf(e);
  return scope === 'run' || (scope !== null && scope in SHARES) ? (scope as Refusal) : null;
}

/** Firestore's own quota (429 `RESOURCE_EXHAUSTED`), never a budget's refusal, whatever order a runner checks them in. */
export const firestoreQuota = (e: unknown): boolean =>
  e instanceof FirestoreError && !budgetScopeOf(e) && (e.code === 'resource-exhausted' || /\b429\b|RESOURCE_EXHAUSTED/.test(e.message));

/**
 * A portal request's budget (src/api.ts, src/mail/api.ts, an inbox's report after its unit): counted
 * and capped at REQUEST_READS, with no share of the day: a member's own action, a handful of reads.
 */
export const requestBudget = (): ReadBudget => new ReadBudget({ run: REQUEST_READS });

/** Firestore said its quota is used up: checks and work wait FIRESTORE_PAUSE_MS. */
export const pauseFirestore = (env: Env, now: number): Promise<void> => ledger(env).pause(now + FIRESTORE_PAUSE_MS);

/** Milliseconds from `now` to the next midnight Pacific (when the day's shares and Firestore's quota start again). */
export const untilNextDay = untilNextQuotaDay;

/** The `meta` key of the work's reads on the quota day of `now`. */
export const workReadsKey = (now: number): string => `work-reads:${quotaDay(now)}`;

/** The days' counts before yesterday's (src/tick.ts, hourly). */
export async function forgetWorkReads(env: Env, now: number): Promise<void> {
  await ledger(env).prune(Object.keys(SHARES), now);
}
