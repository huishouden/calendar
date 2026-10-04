import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { DEFAULT_RULES, planAlerts, readAlert, transactionDoc, type AlertCard } from '@huishouden/pwa-kit/spending-core';
import type { MailMessage } from '@huishouden/pwa-kit/mail-core';
import { handleApi } from '../src/api';
import { checkInboxes } from '../src/mail/check';
import type { MailStatus } from '../src/mail/api';
import { PARSER_VERSION } from '../src/mail/recheck';
import { maskLine, maskSender } from '../src/mail/shape';
import { inboxIdOf } from '../src/mail/store';
import type { ReviewItem } from '../src/mail/store';
import readings from './fixtures/alert-readings.json';
import { apiRequest, deleteDoc, drain, FIRESTORE, household, listDocs, readDoc, refreshFor, resetFirestore, seed, world, writeDoc, TZ, type World } from './helpers/world';

// Alerts read with confidence: only purchases a rule reads become transactions, the rest is asked
// about or left alone; imports can be undone; past imports are read again when the parser changes.
// Every card, sender and shop is invented.

let w: World;
const MIN = 60_000;
const H = `households/${household}`;
const BANK = 'alerts@bank.example.com';
const CARDS = {
  c1: { name: 'Card One', last4: '1111', alertWords: [BANK, 'visa.com'], createdAt: 1, by: 'alice@example.com' },
  c2: { name: 'Card Two', last4: '2222', alertWords: [BANK], createdAt: 1, by: 'alice@example.com' },
  c4: { name: 'Card Four', last4: '4444', alertWords: ['notifications@invest.example.com', 'news@shop.example.com'], createdAt: 1, by: 'alice@example.com' },
};
const cards: AlertCard[] = Object.values(CARDS).map(({ name, last4, alertWords }) => ({ name, last4, alertWords }));

beforeAll(async () => {
  await resetFirestore();
});

beforeEach(async () => {
  await resetFirestore();
  await seed();
  for (const [id, card] of Object.entries(CARDS)) await writeDoc(`${H}/spendingCards/${id}`, card);
  await writeDoc(`${H}/spendingTransactions/st-groceries`, { date: '2031-09-25', description: 'EXAMPLE GROCERY', amount: 61.15, category: 'Groceries', card: 'Card One', type: 'Sale', source: 'statement', createdAt: 1, by: 'alice@example.com' });
  w = world();
});

const call = (path: string, email: string, body?: Record<string, unknown>) => handleApi(w.env, apiRequest(path, email, body), undefined, { fetch: w.fetch, now: w.clock.now, firestoreUrl: FIRESTORE });
const status = async (email = 'bob@example.com') => (await (await call(`/api/mail/status?household=${household}`, email)).json()) as MailStatus;
const alerts = async () => (await listDocs(`${H}/spendingTransactions`)).filter((d) => d.data.source === 'alert');

async function connect(email = 'bob@example.com') {
  const res = await call('/api/mail/connect', email, { household, code: 'gmail-alerts', refreshToken: refreshFor(email), timeZone: TZ });
  expect(res.status).toBe(200);
  return inboxIdOf(household, 'alerts@example.com');
}

async function tick(minutes = 5) {
  w.clock.now += minutes * MIN;
  const { results } = await w.env.DB.prepare('SELECT id FROM inboxes').all<{ id: string }>();
  await checkInboxes(w.env, results.map((r) => r.id), { fetch: w.fetch, now: w.clock.now, firestoreUrl: FIRESTORE });
  await drain(w);
}

type Fixture = { from: string; subject: string; text?: string; html?: string; bulk?: boolean };

/** Every reading fixture in the inbox; returns the MailMessage form of each, as the app reads it. */
function deliverReadings(): MailMessage[] {
  const sentAt = w.clock.now - 3 * 3_600_000;
  return readings.map((f, i) => {
    const e = f.email as Fixture;
    const at = sentAt + i * MIN;
    const id = w.gmail.deliver('alerts', { ...e, at });
    return { id, date: at, ...e };
  });
}

describe('reading with confidence', () => {
  test('parity: the Worker writes exactly the purchases the kit reads, and lists the unreadable for review', async () => {
    const messages = deliverReadings();
    const id = await connect();
    await drain(w);
    // The app's own reading of the same emails, against the same household.
    const existing = [{ id: 'st-groceries', date: '2031-09-25', description: 'EXAMPLE GROCERY', amount: 61.15, card: 'Card One', source: 'statement' }];
    const app = planAlerts(messages, { cards, rules: DEFAULT_RULES, existing, timeZone: TZ });
    const purchases = messages.filter((m) => readAlert(m, cards, DEFAULT_RULES, { timeZone: TZ }).kind === 'purchase');
    expect(purchases.length).toBe(readings.filter((f) => f.expected.kind === 'purchase').length);
    const unreadable = app.review;
    const docs = await alerts();
    expect(docs.map((d) => d.id).sort()).toEqual(app.create.map((t) => t.id).sort());
    for (const tx of app.create) {
      const doc = docs.find((d) => d.id === tx.id)!;
      expect(doc.data).toEqual(transactionDoc({ ...tx, importId: doc.data.importId as string }, 'alert', 'bob@example.com', w.clock.now));
    }
    // No prose, no placeholder, no brokerage amount anywhere.
    for (const d of docs) {
      expect(d.data.description).not.toMatch(/reasonable|Card Purchase|^options$/i);
      expect([6000, 115, 33, 40.03]).not.toContain(d.data.amount);
    }

    const s = await status();
    expect(s.inboxes[0].lastImport).toEqual({ id: expect.stringMatching(/^im-/), at: w.clock.now, added: app.create.length, review: unreadable.length, done: true, undone: false });
    expect(s.inboxes[0].review).toBe(unreadable.length);
    const list = (await (await call(`/api/mail/review?household=${household}&inbox=${id}`, 'bob@example.com')).json()) as { items: ReviewItem[] };
    expect(list.items.map((i) => i.subject).sort()).toEqual(unreadable.map((x) => x.subject).sort());
    expect(list.items.find((i) => i.subject === 'Card purchase')).toMatchObject({ amount: 40.03, reason: 'no-merchant' });
  });

  test('only the member who connected the inbox sees its emails; their answers take them off the list for good', async () => {
    deliverReadings();
    const id = await connect();
    await drain(w);
    expect((await call(`/api/mail/review?household=${household}&inbox=${id}`, 'alice@example.com')).status).toBe(403);
    expect((await call(`/api/mail/review?household=${household}&inbox=${id}`, 'helen@example.com')).status).toBe(403);
    const list = (await (await call(`/api/mail/review?household=${household}&inbox=${id}`, 'bob@example.com')).json()) as { items: ReviewItem[] };
    expect(list.items.length).toBe(2);
    const [first, second] = list.items;
    let res = await call('/api/mail/review', 'bob@example.com', { household, inbox: id, msg: first.msg, answer: 'not-purchase' });
    expect(((await res.json()) as { items: ReviewItem[] }).items.map((i) => i.msg)).toEqual([second.msg]);
    res = await call('/api/mail/review', 'bob@example.com', { household, inbox: id, msg: second.msg, answer: 'entered' });
    expect(((await res.json()) as { items: ReviewItem[] }).items).toEqual([]);
    expect((await call('/api/mail/review', 'bob@example.com', { household, inbox: id, msg: second.msg, answer: 'maybe' })).status).toBe(400);
    const s = await status();
    expect(s.inboxes[0].review).toBe(0);
    expect(s.inboxes[0].lastImport?.review).toBe(0);
    // Read again by a newer parser: answered emails stay answered.
    await w.env.DB.prepare('UPDATE inboxes SET rechecked = 0').run();
    await w.env.DB.prepare('UPDATE inbox_seen SET parsed = 0').run();
    await tick();
    expect((await status()).inboxes[0].review).toBe(0);
  });

  test('the subjects the member is asked about are sealed in D1', async () => {
    deliverReadings();
    await connect();
    await drain(w);
    const { results } = await w.env.DB.prepare('SELECT subject FROM inbox_review').all<{ subject: string }>();
    expect(results.length).toBe(2);
    for (const r of results) expect(r.subject).not.toMatch(/purchase|card/i);
  });
});

describe('undo last import', () => {
  test('deletes, as the caller, the transactions that import wrote, and they are not written again', async () => {
    deliverReadings();
    const id = await connect();
    await drain(w);
    const before = await alerts();
    expect(before.length).toBeGreaterThan(0);
    const { lastImport } = (await status()).inboxes[0];
    expect((await call('/api/mail/undo', 'helen@example.com', { household, inbox: id, importId: lastImport!.id })).status).toBe(403);
    expect((await call('/api/mail/undo', 'bob@example.com', { household, inbox: id, importId: 'im-other' })).status).toBe(409);
    // A member's own transaction and the statement row are not the import's.
    await writeDoc(`${H}/spendingTransactions/mine`, { date: '2031-10-01', description: 'EXAMPLE CAFE', amount: 4, category: 'Dining & Food', card: 'Card One', type: 'Sale', source: 'statement', createdAt: 1, by: 'bob@example.com' });
    const res = await call('/api/mail/undo', 'alice@example.com', { household, inbox: id, importId: lastImport!.id });
    expect(res.status).toBe(200);
    const after = (await res.json()) as MailStatus;
    expect(after.inboxes[0].lastImport).toMatchObject({ id: lastImport!.id, undone: true });
    expect(await alerts()).toEqual([]);
    expect(await readDoc(`${H}/spendingTransactions/mine`)).not.toBeNull();
    expect(await readDoc(`${H}/spendingTransactions/st-groceries`)).not.toBeNull();
    // A newer parser reading everything again leaves them undone.
    await w.env.DB.prepare('UPDATE inboxes SET rechecked = 0').run();
    await w.env.DB.prepare('UPDATE inbox_seen SET parsed = 0').run();
    await tick();
    expect(await alerts()).toEqual([]);
  });
});

describe('re-reading past imports', () => {
  /** An inbox as the first checker left it: junk written, every email read with parser 1. */
  async function legacy() {
    const t = w.clock.now - 3 * 3_600_000;
    const ids = {
      offer: w.gmail.deliver('alerts', { from: 'Example Invest <notifications@invest.example.com>', subject: 'Trade options at a reasonable price', text: 'Trade options at a reasonable price. Contracts from $0.03 each.\nUnsubscribe', bulk: true, at: t }),
      deposit: w.gmail.deliver('alerts', { from: 'Example Invest <notifications@invest.example.com>', subject: 'Your deposit is complete', text: 'Your deposit of $6,000.00 has completed and is available to invest.', at: t + MIN }),
      vague: w.gmail.deliver('alerts', { from: BANK, subject: 'Card purchase', text: 'A charge was made on your card ending in 1111 for $40.03.', at: t + 2 * MIN }),
      real: w.gmail.deliver('alerts', { from: BANK, subject: 'Transaction alert', text: 'You made a $12.50 transaction with EXAMPLE DINER on 09/30/2031 on your card ending in 1111.', at: t + 3 * MIN }),
      missed: w.gmail.deliver('alerts', { from: 'Visa Purchase Alerts <DoNotReplyVisaPurchaseAlerts@visa.com>', subject: 'Visa Purchase Alerts: 19.99 USD at EXAMPLE MUSIC P12AB in +15555550100 on Card 1111', text: 'A purchase was made.', at: t + 4 * MIN }),
      deleted: w.gmail.deliver('alerts', { from: BANK, subject: 'Card alert', text: 'You spent $9.00 at a reasonable price.', at: t + 5 * MIN }),
      gone: w.gmail.deliver('alerts', { from: BANK, subject: 'Card alert', text: 'You spent $3.00 at an example.', at: t + 6 * MIN }),
      app: w.gmail.deliver('alerts', { from: 'Example Invest <notifications@invest.example.com>', subject: 'Model portfolio', text: 'Your Model portfolio gained $1.45 today.', at: t + 7 * MIN }),
    };
    const id = await connect();
    await drain(w);
    const day = '2031-10-01';
    const junk = (description: string, amount: number, extra: Record<string, unknown> = {}) => ({ date: day, description, amount, category: 'Miscellaneous', card: 'Card One', type: 'Sale', source: 'alert', createdAt: w.clock.now, by: 'bob@example.com', ...extra });
    await writeDoc(`${H}/spendingTransactions/al-${ids.offer}`, junk('a reasonable price', 0.03, { emailId: ids.offer }));
    await writeDoc(`${H}/spendingTransactions/al-${ids.deposit}`, junk('Card Purchase', 6000, { emailId: ids.deposit }));
    await writeDoc(`${H}/spendingTransactions/al-${ids.vague}`, junk('Card Purchase', 40.03, { emailId: ids.vague }));
    await writeDoc(`${H}/spendingTransactions/al-${ids.real}`, junk('Card Purchase', 12.5, { emailId: ids.real }));
    await writeDoc(`${H}/spendingTransactions/al-${ids.gone}`, junk('an example', 3, { emailId: ids.gone }));
    // The app's own Check email wrote this one before the inbox was connected: not the checker's.
    await writeDoc(`${H}/spendingTransactions/al-${ids.app}`, junk('Model', 1.45, { emailId: ids.app, createdAt: w.clock.now - 86_400_000 }));
    // The visa alert wrote nothing (the old parser missed it); the "deleted" one was deleted by the member.
    await deleteDoc(`${H}/spendingTransactions/al-${ids.missed}`);
    await w.env.DB.prepare(`DELETE FROM inbox_review`).run();
    await w.env.DB.prepare(`UPDATE inbox_seen SET parsed = 1, state = NULL, import_id = NULL`).run();
    await w.env.DB.prepare(`UPDATE inboxes SET rechecked = 1, import_id = NULL, import_at = NULL, import_added = 0, import_review = 0, import_open = 0`).run();
    w.gmail.remove('alerts', ids.gone);
    return { id, ids };
  }

  test('corrects, deletes and asks, as the member, and leaves alone what it did not write', async () => {
    const { ids } = await legacy();
    await tick();
    await tick();
    await tick();
    const docs = Object.fromEntries((await alerts()).map((d) => [d.id, d.data]));
    expect(docs[`al-${ids.offer}`]).toBeUndefined();
    expect(docs[`al-${ids.deposit}`]).toBeUndefined();
    expect(docs[`al-${ids.vague}`]).toBeUndefined();
    expect(docs[`al-${ids.real}`]).toMatchObject({ description: 'EXAMPLE DINER', date: '2031-09-30', amount: 12.5, category: 'Dining & Food', card: 'Card One', last4: '1111', updatedAt: expect.any(Number) });
    expect(docs[`al-${ids.missed}`]).toMatchObject({ description: 'EXAMPLE MUSIC P12AB', amount: 19.99, card: 'Card One' });
    // Deleted from Gmail: what was written stays as it was.
    expect(docs[`al-${ids.gone}`]).toMatchObject({ description: 'an example' });
    // Written by the app's own check: untouched.
    expect(docs[`al-${ids.app}`]).toMatchObject({ description: 'Model', amount: 1.45 });
    expect(await readDoc(`${H}/spendingTransactions/st-groceries`)).not.toBeNull();

    const s = (await status()).inboxes[0];
    expect(s.review).toBe(2);
    const row = await w.env.DB.prepare('SELECT rechecked, import_open FROM inboxes').first<{ rechecked: number; import_open: number }>();
    expect(row).toEqual({ rechecked: PARSER_VERSION, import_open: 0 });
    // Done: the next checks read nothing again.
    const calls = w.gmail.calls.length;
    await tick();
    expect(w.gmail.calls.slice(calls).filter((c) => c.startsWith('get'))).toEqual([]);
  });

  test('keeps only the shape of what it read: no merchant, amount or address', async () => {
    await legacy();
    await tick();
    await tick();
    await tick();
    const { results } = await w.env.DB.prepare('SELECT sender, subject, lines, outcome FROM mail_shapes').all<{ sender: string; subject: string; lines: string; outcome: string }>();
    expect(results.length).toBeGreaterThan(4);
    const all = JSON.stringify(results);
    for (const secret of ['EXAMPLE', 'DINER', 'MUSIC', '12.50', '6,000', '1111', '+1555', 'P12AB']) expect(all).not.toContain(secret);
    expect(results.map((r) => r.outcome)).toEqual(expect.arrayContaining(['purchase:transaction-with', 'purchase:visa-alert', 'unreadable:no-merchant', 'not-purchase:bulk']));
    expect(results.find((r) => r.outcome === 'purchase:transaction-with')).toMatchObject({ sender: 'alerts@bank.example.com', subject: 'Transaction alert', lines: JSON.stringify(['You made a $# transaction with X on #/#/# on your card ending in #.']) });
  });
});

describe('a newer parser takes emails off the review list', () => {
  test('account notices put on the list by an older parser leave it, and the last import says so', async () => {
    const t = w.clock.now - 3 * 3_600_000;
    const order = w.gmail.deliver('alerts', { from: 'Example Invest <notifications@invest.example.com>', subject: 'Option order executed', text: '<div style="color:#333">Your order to buy 1 contract of EXMPL was executed at an average price of $1.15 per contract.</div><table width="100%"><tr><td>Total cost: $115.00</td></tr></table>', at: t });
    const vague = w.gmail.deliver('alerts', { from: BANK, subject: 'Card purchase', text: 'A charge was made on your card ending in 1111 for $40.03.', at: t + MIN });
    const id = await connect();
    await drain(w);
    // As the older parser left it: both on the list, from one import.
    const { putReview } = await import('../src/mail/store');
    const importId = (await status()).inboxes[0].lastImport!.id;
    await w.env.DB.batch([await putReview(w.env, id, { msg: order, subject: 'Option order executed', sent: t, date: '2031-10-01', amount: 115, reason: 'no-merchant' }, importId, w.clock.now)]);
    await w.env.DB.prepare(`UPDATE inbox_seen SET parsed = ${PARSER_VERSION - 1}, state = 'review', import_id = ? WHERE msg = ?`).bind(importId, order).run();
    await w.env.DB.prepare(`UPDATE inboxes SET rechecked = ${PARSER_VERSION - 1}, import_review = 2`).run();
    expect((await status()).inboxes[0].review).toBe(2);
    await tick();
    await tick();
    const s = (await status()).inboxes[0];
    expect(s.review).toBe(1);
    expect(s.lastImport?.review).toBe(1);
    const list = (await (await call(`/api/mail/review?household=${household}&inbox=${id}`, 'bob@example.com')).json()) as { items: ReviewItem[] };
    expect(list.items.map((i) => i.msg)).toEqual([vague]);
  });
});

describe('shapes', () => {
  test('words outside the alert vocabulary, numbers and amounts are masked', () => {
    expect(maskLine('You made a $45.76 transaction with PUBLIX STORE #228 on Oct 2, 2031')).toBe('You made a $# transaction with X ## on Oct #, #');
    expect(maskLine('Caleb, your Gold card was used at Example Bar')).toBe('X, your Gold card was used at X');
    expect(maskLine('123.45 USD at SHOP in Springfield')).toBe('$# USD at X in X');
    expect(maskSender('Visa Purchase Alerts <DoNotReplyVisaPurchaseAlerts@visa.com>')).toBe('donotreplyvisapurchasealerts@visa.com');
    expect(maskSender('Example Invest <notifications@invest.example.com>')).toBe('notifications@invest.example.com');
    expect(maskSender('Jo <jo.smith@mail.example.com>')).toBe('X@mail.example.com');
  });
});
