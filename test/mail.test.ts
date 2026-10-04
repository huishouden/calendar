import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { DEFAULT_RULES, planAlerts, transactionDoc, type AlertCard } from '@huishouden/pwa-kit/spending-core';
import type { MailMessage } from '@huishouden/pwa-kit/mail-core';
import { handleApi } from '../src/api';
import { captureLogs } from '../src/log';
import { checkInboxes, MAIL_EVERY_MIN, QUIET_WRITE_MS, runMailCron } from '../src/mail/check';
import { inboxIdOf, inboxRow, inboxShard } from '../src/mail/store';
import { PER_UNIT, runMailWork } from '../src/mail/work';
import type { MailStatus } from '../src/mail/api';
import fixtures from './fixtures/card-alerts.json';
import { apiRequest, drain, FIRESTORE, household, listDocs, readDoc, refreshFor, resetFirestore, seed, world, writeDoc, TZ, type World } from './helpers/world';

// Spending's alert inboxes: a member connects a Gmail account (any account), and the Worker checks
// it every few minutes as that member. Google, Gmail and Firebase Auth are faked; Firestore is the
// emulator with the household's rules. Every card, sender and shop is invented.

let w: World;
const MIN = 60_000;
const DAY = 86_400_000;
const H = `households/${household}`;
const BANK = 'alerts@bank.example.com';
const CARDS = {
  c1: { name: 'Card One', last4: '1111', alertWords: [BANK], createdAt: 1, by: 'alice@example.com' },
  c2: { name: 'Card Two', last4: '2222', alertWords: [BANK, 'alerts@cardtwo.example.com', 'blue'], createdAt: 1, by: 'alice@example.com' },
  c3: { name: 'Card Three', last4: '3333', alertWords: ['notices@card.example.com'], createdAt: 1, by: 'alice@example.com' },
};

beforeAll(async () => {
  await resetFirestore();
});

beforeEach(async () => {
  await resetFirestore();
  await seed();
  for (const [id, card] of Object.entries(CARDS)) await writeDoc(`${H}/spendingCards/${id}`, card);
  // The household's newest transaction: the first check looks back to two days before it.
  await writeDoc(`${H}/spendingTransactions/st-groceries`, { date: '2031-09-25', description: 'EXAMPLE GROCERY', amount: 61.15, category: 'Groceries', card: 'Card One', type: 'Sale', source: 'statement', createdAt: 1, by: 'alice@example.com' });
  w = world();
});

const call = (path: string, email: string, body?: Record<string, unknown>) => handleApi(w.env, apiRequest(path, email, body), undefined, { fetch: w.fetch, now: w.clock.now, firestoreUrl: FIRESTORE });
const status = async (email = 'alice@example.com') => (await (await call(`/api/mail/status?household=${household}`, email)).json()) as MailStatus;

const at = (iso: string) => Date.parse(iso);
const purchase = (amount: string, shop: string, last4 = '1111', when = w.clock.now - 5 * MIN) => ({ from: BANK, subject: 'Transaction alert', text: `You made a $${amount} transaction with ${shop} on your card ending in ${last4}.`, at: when });

async function connect(email = 'bob@example.com', name = 'alerts') {
  const res = await call('/api/mail/connect', email, { household, code: `gmail-${name}`, refreshToken: refreshFor(email), timeZone: TZ });
  expect(res.status).toBe(200);
  return { id: await inboxIdOf(household, `${name}@example.com`), body: (await res.json()) as MailStatus };
}

const alerts = async () => (await listDocs(`${H}/spendingTransactions`)).filter((d) => d.data.source === 'alert');

/** The cron's check of every inbox now (whatever their slot), then the queued imports. */
async function tick(minutes = MAIL_EVERY_MIN) {
  w.clock.now += minutes * MIN;
  const { results } = await w.env.DB.prepare('SELECT id FROM inboxes').all<{ id: string }>();
  const totals = await checkInboxes(w.env, results.map((r) => r.id), { fetch: w.fetch, now: w.clock.now, firestoreUrl: FIRESTORE });
  await drain(w);
  return totals;
}

describe('connecting an alert inbox', () => {
  test('a member connects another Google account; the first check reads alerts since the newest transaction', async () => {
    w.gmail.deliver('alerts', purchase('4.00', 'OLD KIOSK', '1111', at('2031-09-20T10:00:00Z')));
    w.gmail.deliver('alerts', purchase('12.30', 'NOODLE BAR', '1111', at('2031-09-29T18:00:00Z')));
    w.gmail.deliver('alerts', purchase('8.10', 'BOOKSHOP', '2222', at('2031-10-01T09:00:00Z')));
    w.gmail.deliver('alerts', { from: 'friend@example.com', subject: 'Dinner?', text: 'Are we still on for $20.00 pizza night?', at: at('2031-10-01T09:30:00Z') });

    const { id, body } = await connect();
    expect(body.inboxes).toEqual([
      expect.objectContaining({ id, address: 'alerts@example.com', by: 'bob@example.com', mine: true, connectedAt: w.clock.now, error: null, checking: true }),
    ]);
    // In the household, in Bob's name; no token anywhere in Firestore.
    expect(await readDoc(`${H}/spendingInboxes/${id}`)).toEqual({ address: 'alerts@example.com', connectedAt: w.clock.now, updatedAt: w.clock.now, by: 'bob@example.com' });

    await drain(w);
    const docs = await alerts();
    expect(docs.map((d) => d.data.description).sort()).toEqual(['BOOKSHOP', 'NOODLE BAR']);
    expect(docs.find((d) => d.data.description === 'NOODLE BAR')!.data).toEqual({
      date: '2031-09-29', description: 'NOODLE BAR', amount: 12.3, category: 'Miscellaneous', card: 'Card One', type: 'Sale', source: 'alert', last4: '1111', emailId: expect.any(String), createdAt: w.clock.now, by: 'bob@example.com',
    });
    const inbox = await readDoc(`${H}/spendingInboxes/${id}`);
    expect(inbox).toMatchObject({ lastAlertAt: w.clock.now, lastAdded: 2 });
    const s = await status();
    expect(s.inboxes[0]).toMatchObject({ lastAlertAt: w.clock.now, lastAdded: 2, checking: false, mine: false, by: 'bob@example.com' });
    expect(s.lastChecked).toBe(w.clock.now);
  });

  test("an alert's day is the household's, not the server's (UTC)", async () => {
    // 23:30 UTC on 30 September is 01:30 on 1 October in Amsterdam.
    w.gmail.deliver('alerts', purchase('3.50', 'LATE KIOSK', '1111', at('2031-09-30T23:30:00Z')));
    await connect();
    await drain(w);
    expect((await alerts())[0].data.date).toBe('2031-10-01');
  });

  test('helpers, kids and people outside the household can neither connect nor see inboxes', async () => {
    for (const who of ['helen@example.com', 'kim@example.com']) {
      expect((await call('/api/mail/connect', who, { household, code: 'gmail-alerts', refreshToken: refreshFor(who), timeZone: TZ })).status).toBe(403);
      expect((await call(`/api/mail/status?household=${household}`, who)).status).toBe(403);
    }
    expect((await call(`/api/mail/status?household=${household}`, 'mallory@example.com')).status).toBe(403);
    expect(await listDocs(`${H}/spendingInboxes`)).toEqual([]);
  });

  test('Gmail left unticked in Google’s window is refused, and nothing is kept', async () => {
    const res = await call('/api/mail/connect', 'bob@example.com', { household, code: 'gmail-denied', refreshToken: refreshFor('bob@example.com'), timeZone: TZ });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('google-denied');
    expect((await status()).inboxes).toEqual([]);
  });

  test('a refresh token that is not the caller’s is refused', async () => {
    const res = await call('/api/mail/connect', 'bob@example.com', { household, code: 'gmail-alerts', refreshToken: refreshFor('alice@example.com'), timeZone: TZ });
    expect(res.status).toBe(400);
  });

  test('two inboxes (two partners’ cards), each checked as the member who connected it', async () => {
    w.gmail.deliver('alerts', purchase('5.00', 'KIOSK', '1111'));
    w.gmail.deliver('partner', purchase('9.99', 'CINEMA', '2222'));
    await connect('bob@example.com', 'alerts');
    await connect('alice@example.com', 'partner');
    await drain(w);
    const docs = await alerts();
    expect(docs.map((d) => [d.data.description, d.data.by]).sort()).toEqual([
      ['CINEMA', 'alice@example.com'],
      ['KIOSK', 'bob@example.com'],
    ]);
    expect((await status()).inboxes.map((i) => i.address).sort()).toEqual(['alerts@example.com', 'partner@example.com']);
  });
});

describe('checks', () => {
  test('nothing arrived: one history request, no search, no Firestore, no D1 write', async () => {
    const { id } = await connect();
    await drain(w);
    const before = await inboxRow(w.env, id);
    w.gmail.calls.length = 0;
    w.authCalls.length = 0;
    await tick();
    expect(w.gmail.calls).toEqual(['history alerts@example.com']);
    expect(w.authCalls).toEqual([]);
    expect(await inboxRow(w.env, id)).toEqual(before);
  });

  test('mail that is not an alert: a search, nothing read or written', async () => {
    const { id } = await connect();
    await drain(w);
    w.gmail.deliver('alerts', { from: 'news@example.com', subject: 'Weekly news', text: 'Nothing about money', at: w.clock.now });
    w.gmail.calls.length = 0;
    const totals = await tick();
    expect(totals).toMatchObject({ arrived: 1, searched: 1, queued: 0 });
    expect(w.gmail.calls).toEqual(['history alerts@example.com', 'search alerts@example.com']);
    expect(await alerts()).toEqual([]);
    // The history id and `since` move on at most every half hour (repeating the search is cheap).
    const since = (await inboxRow(w.env, id))!.since;
    w.gmail.deliver('alerts', { from: 'news@example.com', subject: 'More news', text: 'Still nothing', at: w.clock.now });
    await tick(QUIET_WRITE_MS / MIN);
    expect((await inboxRow(w.env, id))!.since).toBeGreaterThan(since);
    expect((await inboxRow(w.env, id))!.since).toBe(w.clock.now);
  });

  test('a new alert arrives within one check: read once, written once', async () => {
    await connect();
    await drain(w);
    w.gmail.deliver('alerts', purchase('27.10', 'EXAMPLE BOOKSHOP', '1111', w.clock.now + MIN));
    await tick();
    expect((await alerts()).map((d) => d.data.description)).toEqual(['EXAMPLE BOOKSHOP']);
    w.gmail.calls.length = 0;
    await tick();
    await tick();
    expect(w.gmail.calls.filter((c) => c.startsWith('get'))).toEqual([]);
    expect(await alerts()).toHaveLength(1);
  });

  test('an alert for a purchase the household has (a statement row, another member’s check) is not added', async () => {
    await connect();
    await drain(w);
    // The statement row for the grocery purchase, and an alert the app already wrote for the kiosk.
    await writeDoc(`${H}/spendingTransactions/al-other`, { date: '2031-10-01', description: 'KIOSK', amount: 5, category: 'Miscellaneous', card: 'Card One', type: 'Sale', source: 'alert', createdAt: 1, by: 'alice@example.com' });
    w.gmail.deliver('alerts', purchase('61.15', 'EXAMPLE GROCERY #12', '1111', at('2031-09-26T10:00:00Z') + 6 * DAY));
    w.gmail.deliver('alerts', purchase('5.00', 'KIOSK', '1111', w.clock.now + MIN));
    w.gmail.deliver('alerts', purchase('5.00', 'KIOSK', '1111', w.clock.now + 2 * MIN));
    await tick();
    const added = (await alerts()).filter((d) => d.data.by === 'bob@example.com');
    // The grocery alert is 7 days after the statement: a new purchase. The first kiosk alert is the one
    // already there; the second, as in the app, is a second purchase (two emails never both match one).
    expect(added.map((d) => d.data.description).sort()).toEqual(['EXAMPLE GROCERY #12', 'KIOSK']);
  });

  test(`more alerts than one unit reads (${PER_UNIT}): the next units read the rest, oldest first`, async () => {
    w.gmail.listPage = 4;
    w.gmail.historyPage = 2;
    for (let i = 0; i < 10; i++) w.gmail.deliver('alerts', purchase(`${10 + i}.00`, `SHOP ${String.fromCharCode(65 + i)}`, '1111', w.clock.now - (10 - i) * MIN));
    await connect();
    const units = await drain(w);
    expect(units).toBeGreaterThanOrEqual(1);
    const docs = await alerts();
    expect(docs).toHaveLength(10);
    // Further mail, over several history pages, is still found.
    for (let i = 0; i < 5; i++) w.gmail.deliver('alerts', purchase(`${30 + i}.00`, `STALL ${String.fromCharCode(65 + i)}`, '1111', w.clock.now + MIN));
    await tick();
    expect(await alerts()).toHaveLength(15);
  });

  test('history Gmail no longer has (a week without checks): the search covers it', async () => {
    await connect();
    await drain(w);
    w.gmail.deliver('alerts', purchase('15.00', 'HARDWARE STORE', '1111', w.clock.now + MIN));
    w.gmail.expireHistory('alerts');
    await tick();
    expect((await alerts()).map((d) => d.data.description)).toEqual(['HARDWARE STORE']);
  });

  test('Google access removed: the inbox says Reconnect and the checks stop until it is connected again', async () => {
    const { id } = await connect();
    await drain(w);
    w.google.revoked.add('g-refresh-gmail-alerts');
    // A fresh isolate: no cached access token.
    (await import('../src/google/oauth')).forgetAccess();
    await tick();
    expect((await inboxRow(w.env, id))!.error).toBe('revoked');
    expect((await readDoc(`${H}/spendingInboxes/${id}`))!.error).toBe('revoked');
    expect((await status()).inboxes[0]).toMatchObject({ error: 'revoked', checking: false });
    w.gmail.calls.length = 0;
    await tick();
    expect(w.gmail.calls).toEqual([]);
    // Reconnecting clears it.
    w.google.revoked.clear();
    await connect();
    await drain(w);
    expect((await status()).inboxes[0].error).toBeNull();
    expect((await readDoc(`${H}/spendingInboxes/${id}`))!.error).toBeUndefined();
  });

  test('Gmail’s rate limit backs the inbox off', async () => {
    const { id } = await connect();
    await drain(w);
    w.gmail.failNext = { status: 429, reason: 'rateLimitExceeded', count: 1 };
    w.gmail.deliver('alerts', purchase('1.00', 'GUM', '1111', w.clock.now + MIN));
    await tick();
    const row = await inboxRow(w.env, id);
    expect(row!.backoff_until).toBeGreaterThan(w.clock.now);
    await tick(10);
    expect((await alerts()).map((d) => d.data.description)).toEqual(['GUM']);
  });

  test('no alert words or labels: nothing to search, said on the inbox', async () => {
    for (const id of Object.keys(CARDS)) await writeDoc(`${H}/spendingCards/${id}`, { ...CARDS[id as keyof typeof CARDS], alertWords: [] });
    const { id } = await connect();
    await drain(w);
    expect((await status()).inboxes[0].error).toBe('nothing-to-search');
    expect((await readDoc(`${H}/spendingInboxes/${id}`))!.error).toBe('nothing-to-search');
    // Words added, then Check now: it searches again.
    await writeDoc(`${H}/spendingCards/c1`, CARDS.c1);
    w.gmail.deliver('alerts', purchase('2.00', 'TEA', '1111'));
    expect((await call('/api/mail/check', 'alice@example.com', { household })).status).toBe(200);
    await drain(w);
    expect((await alerts()).map((d) => d.data.description)).toEqual(['TEA']);
    expect((await status()).inboxes[0].error).toBeNull();
  });

  test('the cron checks the inboxes due this minute and records the minute for "Updated ... ago"', async () => {
    const { id } = await connect();
    await drain(w);
    const shard = inboxShard(id);
    // The next minute this inbox is due in.
    let now = w.clock.now + MIN;
    while (Math.floor(now / MIN) % MAIL_EVERY_MIN !== shard % MAIL_EVERY_MIN) now += MIN;
    w.clock.now = now;
    const totals = await runMailCron(w.env, { now, fetch: w.fetch });
    expect(totals).toMatchObject({ due: 1, checked: 1 });
    expect((await status()).lastChecked).toBe(now);
  });

  test('the logs hold counts, never an address, a merchant or a subject', async () => {
    const logs = captureLogs();
    try {
      w.gmail.deliver('alerts', purchase('6.66', 'SECRET SHOP', '1111'));
      await connect();
      await drain(w);
      await tick();
    } finally {
      logs.restore();
    }
    const all = logs.lines.join('\n');
    expect(all).toContain('"added":1');
    for (const s of ['alerts@example.com', 'bob@example.com', 'SECRET SHOP', 'Transaction alert', BANK, household]) expect(all).not.toContain(s);
  });
});

describe('disconnecting', () => {
  test('the member who connected it: Google’s grant revoked, the inbox and its seen list deleted', async () => {
    const { id } = await connect();
    await drain(w);
    const res = await call('/api/mail/disconnect', 'bob@example.com', { household, inbox: id });
    expect(res.status).toBe(200);
    expect(w.google.revoked.has('g-refresh-gmail-alerts')).toBe(true);
    expect(await inboxRow(w.env, id)).toBeNull();
    expect(await readDoc(`${H}/spendingInboxes/${id}`)).toBeNull();
    expect((await w.env.DB.prepare('SELECT COUNT(*) AS n FROM inbox_seen').first<{ n: number }>())!.n).toBe(0);
    // The alerts it found stay: they are the household's transactions.
    expect(((await res.json()) as MailStatus).inboxes).toEqual([]);
  });

  test('another member may not; an admin may', async () => {
    const { id } = await connect('bob@example.com');
    await drain(w);
    expect((await call('/api/mail/disconnect', 'cora@example.com', { household, inbox: id })).status).toBe(403);
    expect(await inboxRow(w.env, id)).not.toBeNull();
    expect((await call('/api/mail/disconnect', 'alice@example.com', { household, inbox: id })).status).toBe(200);
    expect(await inboxRow(w.env, id)).toBeNull();
  });
});

// Parity: the Worker reads every card-alert fixture exactly as the app does. The app parses the
// MailMessage the browser builds; the Worker gets Gmail's API shape (base64url parts), turns it into a
// MailMessage with the kit and parses it with the same spending-core. The documents must be equal.
test('parity: every fixture becomes the same transaction document in the Worker as in the app', async () => {
  const sentAt = at('2031-10-01T08:00:00Z');
  const messages: MailMessage[] = [];
  for (const [i, f] of fixtures.entries()) {
    const email = f.email as { from: string; subject: string; text?: string; html?: string };
    const id = w.gmail.deliver('alerts', { ...email, at: sentAt + i * MIN });
    messages.push({ id, date: sentAt + i * MIN, from: email.from, subject: email.subject, ...(email.text !== undefined ? { text: email.text } : {}), ...(email.html !== undefined ? { html: email.html } : {}) });
  }
  await connect();
  await drain(w);
  const cards: AlertCard[] = Object.values(CARDS).map(({ name, last4, alertWords }) => ({ name, last4, alertWords }));
  const existing = [{ id: 'st-groceries', date: '2031-09-25', description: 'EXAMPLE GROCERY', amount: 61.15, card: 'Card One', source: 'statement' }];
  const app = planAlerts(messages, { cards, rules: DEFAULT_RULES, existing, timeZone: TZ });
  const worker = await alerts();
  expect(worker.length).toBe(app.create.length);
  expect(app.create.length).toBe(fixtures.filter((f) => f.expected !== null).length);
  for (const tx of app.create) {
    const doc = worker.find((d) => d.id === tx.id);
    expect(doc?.data).toEqual(transactionDoc(tx, 'alert', 'bob@example.com', doc!.data.createdAt as number));
  }
});
