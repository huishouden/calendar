import { toMailMessage, type MailMessage } from '@huishouden/pwa-kit/mail-core';
import { alertId, dayOf, planImport, readAlert, transactionDoc, type AlertReading, type AlertReview, type AlertTx, type Existing } from '@huishouden/pwa-kit/spending-core';
import type { Env } from '../env';
import type { Person } from '../person';
import { GmailApiError, type Gmail } from './gmail';
import { recordShape } from './shape';
import { ANSWERED, markSeen, newImportId, putReview, type InboxConfig, type InboxRecord, type InboxRow, type SeenState } from './store';

/**
 * Reading alerts, and reading past imports again when the parser changes.
 *
 * PARSER_VERSION goes up with every change to how alerts are read (huishouden/pwa-kit readAlert and
 * its rules). An inbox whose past imports were read with an older one is re-read, a few emails a
 * unit, once nothing new is waiting (src/mail/work.ts): for each email it read before, by its Gmail
 * id in the seen list, as the member who connected it (the household's rules apply):
 *
 * - a transaction the checker wrote for it (`al-<id>`, by that member, written after connecting) is
 *   corrected when the email now reads as a purchase (merchant, date, amount, category, card), and
 *   deleted when it is not one, or can't be read (then the member is asked about it);
 * - an email that wrote nothing before (not a purchase, unreadable, or read by the first checker
 *   without a record of what it became) and now reads as a new purchase is written;
 * - emails the member answered (Not a purchase, entered it, undid the import) are left alone, as are
 *   transactions anyone deleted, statement rows, and alerts the app's own Check email wrote.
 */

/** 1: the first checker. 2: readAlert (purchase rules, review list, transaction dates). */
export const PARSER_VERSION = 2;
/** Emails re-read per unit: each is a Gmail request and a parse, within the free plan's CPU time. */
export const RECHECK_PER_UNIT = 3;

export interface Readings {
  readings: { msg: MailMessage; reading: AlertReading }[];
  /** The purchases to write against what the household has, and the emails to ask about. */
  plan(existing: Existing[]): { create: AlertTx[]; duplicates: number; review: AlertReview[] };
}

export function readMessages(messages: MailMessage[], config: InboxConfig, timeZone: string): Readings {
  const readings = messages.map((msg) => ({ msg, reading: readAlert(msg, config.cards, config.rules, { timeZone }) }));
  return {
    readings,
    plan(existing) {
      const parsed: AlertTx[] = [];
      const review: AlertReview[] = [];
      for (const { msg, reading } of readings) {
        if (reading.kind === 'purchase') parsed.push({ ...reading.tx, id: alertId(msg.id), emailId: msg.id });
        else if (reading.kind === 'unreadable')
          review.push({ emailId: msg.id, subject: msg.subject.slice(0, 200), sent: msg.date, date: reading.date, reason: reading.reason, ...(reading.amount ? { amount: reading.amount } : {}) });
      }
      parsed.sort((a, b) => a.date.localeCompare(b.date));
      const p = planImport(parsed, existing, 'alert');
      return { create: p.create, duplicates: p.duplicates, review };
    },
  };
}

const toExisting = (d: { id: string; data: Record<string, unknown> }): Existing => ({
  id: d.id,
  date: String(d.data.date ?? ''),
  description: String(d.data.description ?? ''),
  amount: typeof d.data.amount === 'number' ? d.data.amount : Number(d.data.amount) || 0,
  card: String(d.data.card ?? ''),
  source: String(d.data.source ?? 'statement'),
});

/** The household's transactions from four days before the oldest email: what new alerts are matched against. */
export async function existingFrom(person: Person, messages: MailMessage[], timeZone: string): Promise<Existing[]> {
  const from = dayOf(Math.min(...messages.map((m) => m.date)) - 4 * 86_400_000, timeZone);
  return (await person.db.query(person.base, 'spendingTransactions', { where: [{ field: 'date', op: 'GREATER_THAN_OR_EQUAL', value: from }] })).map(toExisting);
}

export interface RecheckTotals {
  read: number;
  updated: number;
  deleted: number;
  added: number;
  review: number;
  gone: number;
}

const FIELDS = ['date', 'description', 'amount', 'category', 'card', 'type', 'last4'] as const;

/** One unit of re-reading: RECHECK_PER_UNIT emails read before with an older parser. */
export async function recheckUnit(env: Env, row: InboxRow, record: InboxRecord, person: Person, gmail: Gmail, config: InboxConfig, now: number): Promise<{ more: boolean; totals: RecheckTotals }> {
  const totals: RecheckTotals = { read: 0, updated: 0, deleted: 0, added: 0, review: 0, gone: 0 };
  const { results } = await env.DB.prepare(
    `SELECT msg, state, import_id FROM inbox_seen WHERE inbox = ? AND parsed < ? AND (state IS NULL OR state NOT IN (${ANSWERED.map(() => '?').join(',')})) ORDER BY msg LIMIT ?`,
  )
    .bind(row.id, PARSER_VERSION, ...ANSWERED, RECHECK_PER_UNIT)
    .all<{ msg: string; state: SeenState | null; import_id: string | null }>();
  if (!results.length) {
    await env.DB.prepare('UPDATE inboxes SET rechecked = ?, import_open = 0 WHERE id = ?').bind(PARSER_VERSION, row.id).run();
    return { more: false, totals };
  }

  const fetched = await Promise.all(
    results.map((r) =>
      gmail.get(r.msg).then(toMailMessage, (e) => {
        if (e instanceof GmailApiError && e.status === 404) return null;
        throw e;
      }),
    ),
  );
  const messages = fetched.filter((m): m is MailMessage => !!m);
  const paths = results.map((r) => `${person.base}/spendingTransactions/${alertId(r.msg)}`);
  const docs = await person.getAll(paths);
  const existing = messages.length ? await existingFrom(person, messages, record.timeZone) : [];
  const read = readMessages(messages, config, record.timeZone);
  const byId = new Map(read.readings.map((x) => [x.msg.id, x]));
  const importId = row.import_open && row.import_id ? row.import_id : newImportId(now);

  const writes: Parameters<Person['db']['commit']>[0] = [];
  const seen: { msg: string; state: SeenState; importId?: string | null; parsed: number }[] = [];
  const review: Promise<D1PreparedStatement>[] = [];
  const unask: string[] = [];
  const shapes: D1PreparedStatement[] = [];

  for (const [i, r] of results.entries()) {
    const doc = docs[i];
    const path = paths[i];
    const id = alertId(r.msg);
    const got = byId.get(r.msg);
    if (!got) {
      // Deleted from Gmail: what was written stays.
      totals.gone++;
      seen.push({ msg: r.msg, state: r.state ?? (doc ? 'imported' : 'skipped'), parsed: PARSER_VERSION });
      continue;
    }
    totals.read++;
    shapes.push(recordShape(env, row.id, got.msg, got.reading, now));
    // Only what this checker wrote, as this member, since connecting: never the app's own alerts or statements.
    const ours = !!doc && doc.source === 'alert' && doc.by === record.email && typeof doc.createdAt === 'number' && doc.createdAt >= row.created_at;
    if (doc && !ours) {
      seen.push({ msg: r.msg, state: 'app', parsed: PARSER_VERSION });
      continue;
    }
    const others = existing.filter((e) => e.id !== id);
    const reading = got.reading;
    if (reading.kind === 'purchase') {
      unask.push(r.msg);
      const tx = { ...reading.tx, id, emailId: r.msg };
      const plan = planImport([tx], others, 'alert');
      if (plan.duplicates) {
        if (ours) {
          writes.push({ path, delete: true });
          totals.deleted++;
        }
        seen.push({ msg: r.msg, state: 'duplicate', parsed: PARSER_VERSION });
        continue;
      }
      if (ours) {
        const keep = typeof doc.importId === 'string' ? doc.importId : undefined;
        const next = transactionDoc({ ...tx, ...(keep ? { importId: keep } : {}) }, 'alert', record.email, doc.createdAt as number, now);
        const same = FIELDS.every((k) => (next as Record<string, unknown>)[k] === doc[k]);
        if (!same) {
          writes.push({ path, set: next });
          totals.updated++;
        }
        seen.push({ msg: r.msg, state: 'imported', parsed: PARSER_VERSION });
      } else if (r.state === 'imported' || r.state === 'duplicate') {
        // Written before and deleted since by someone, or the household had it then: not written again.
        seen.push({ msg: r.msg, state: r.state, parsed: PARSER_VERSION });
      } else {
        writes.push({ path, set: transactionDoc({ ...tx, importId }, 'alert', record.email, now) });
        existing.push({ ...tx, source: 'alert' });
        totals.added++;
        seen.push({ msg: r.msg, state: 'imported', importId, parsed: PARSER_VERSION });
      }
      continue;
    }
    if (ours) {
      writes.push({ path, delete: true });
      totals.deleted++;
    }
    if (reading.kind === 'unreadable') {
      review.push(putReview(env, row.id, { msg: r.msg, subject: got.msg.subject, sent: got.msg.date, date: reading.date, amount: reading.amount ?? null, reason: reading.reason }, importId, now));
      if (r.state !== 'review') totals.review++;
      seen.push({ msg: r.msg, state: 'review', importId, parsed: PARSER_VERSION });
    } else {
      unask.push(r.msg);
      seen.push({ msg: r.msg, state: 'skipped', parsed: PARSER_VERSION });
    }
  }

  if (writes.length) await person.db.commit(writes);
  const starting = !(row.import_open && row.import_id);
  const counted = totals.added + totals.review > 0;
  await env.DB.batch([
    ...markSeen(env, row.id, seen, now),
    ...(await Promise.all(review)),
    ...unask.map((msg) => env.DB.prepare('DELETE FROM inbox_review WHERE inbox = ? AND msg = ?').bind(row.id, msg)),
    ...shapes,
    ...(counted
      ? [
          env.DB.prepare(
            `UPDATE inboxes SET import_id = ?1, import_at = ?2, import_added = CASE WHEN ?3 THEN 0 ELSE import_added END + ?4,
               import_review = CASE WHEN ?3 THEN 0 ELSE import_review END + ?5, import_undone = 0, import_open = 1 WHERE id = ?6`,
          ).bind(importId, now, starting ? 1 : 0, totals.added, totals.review, row.id),
        ]
      : []),
  ]);
  return { more: true, totals };
}
