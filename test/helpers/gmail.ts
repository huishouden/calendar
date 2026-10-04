import { encodeBase64Url } from '@huishouden/pwa-kit/mail-core';

/**
 * A stand-in for the Gmail API, enough for the alert checker: one mailbox per Google grant (the code
 * "gmail-<name>" connects <name>@example.com), `profile`, `history.list` with pages and an oldest
 * history id kept (older ones are a 404, as Gmail's are after about a week), `messages.list` with
 * the searches the kit's `alertQuery` makes (from:(), "phrases", label:, after:) and pages, and
 * `messages.get` in Gmail's own shape (base64url parts). All mail is invented.
 */

export interface FakeMail {
  from: string;
  subject: string;
  text?: string;
  html?: string;
  /** ms since epoch. */
  at: number;
  labels?: string[];
}

interface Stored extends FakeMail {
  id: string;
  historyId: number;
}

interface Box {
  address: string;
  messages: Stored[];
  historyId: number;
  /** History ids at or below this are gone (404). */
  floor: number;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export class FakeGmail {
  boxes = new Map<string, Box>();
  /** Every request: "<kind> <address>", e.g. "history alerts@example.com". */
  calls: string[] = [];
  /** History records per page, and messages per search page (Gmail's maxResults, made small to test pages). */
  historyPage = 500;
  listPage = 100;
  failNext: { status: number; reason: string; count: number } | null = null;
  private seq = 0;

  /** The mailbox a code "gmail-<name>" connects. */
  box(name: string): Box {
    let b = this.boxes.get(name);
    if (!b) {
      b = { address: `${name}@example.com`, messages: [], historyId: 1000, floor: 0 };
      this.boxes.set(name, b);
    }
    return b;
  }

  deliver(name: string, mail: FakeMail): string {
    const b = this.box(name);
    b.historyId += 3;
    const id = `m${(++this.seq).toString(16).padStart(6, '0')}`;
    b.messages.push({ ...mail, id, historyId: b.historyId });
    return id;
  }

  /** Gmail forgets history older than now (as after a week without a check). */
  expireHistory(name: string): void {
    const b = this.box(name);
    b.floor = b.historyId;
  }

  async handle(url: string, init: RequestInit = {}): Promise<Response | null> {
    const u = new URL(url);
    if (u.hostname !== 'gmail.googleapis.com') return null;
    const auth = new Headers(init.headers).get('Authorization') ?? '';
    const grant = /~g-refresh-gmail-(.+)$/.exec(auth)?.[1];
    if (!grant) return json(401, { error: { status: 'UNAUTHENTICATED', errors: [{ reason: 'authError' }] } });
    const b = this.box(grant);
    const path = u.pathname.replace('/gmail/v1/users/me/', '');
    if (this.failNext && this.failNext.count > 0) {
      this.failNext.count--;
      return json(this.failNext.status, { error: { errors: [{ reason: this.failNext.reason }] } });
    }
    const q = u.searchParams;
    if (path === 'profile') {
      this.calls.push(`profile ${b.address}`);
      return json(200, { emailAddress: b.address, historyId: String(b.historyId) });
    }
    if (path === 'history') {
      this.calls.push(`history ${b.address}`);
      const start = Number(q.get('startHistoryId'));
      if (start < b.floor) return json(404, { error: { status: 'NOT_FOUND', errors: [{ reason: 'notFound' }] } });
      const all = b.messages.filter((m) => m.historyId > start).map((m) => ({ id: String(m.historyId), messagesAdded: [{ message: { id: m.id, labelIds: m.labels ?? ['INBOX'] } }] }));
      const offset = Number(q.get('pageToken') ?? 0);
      const page = all.slice(offset, offset + this.historyPage);
      const next = offset + this.historyPage < all.length ? String(offset + this.historyPage) : undefined;
      return json(200, { ...(page.length ? { history: page } : {}), historyId: String(b.historyId), ...(next ? { nextPageToken: next } : {}) });
    }
    if (path === 'messages') {
      this.calls.push(`search ${b.address}`);
      const matches = b.messages.filter((m) => matchesSearch(m, q.get('q') ?? '')).sort((x, y) => y.at - x.at);
      const size = Math.min(this.listPage, Number(q.get('maxResults') ?? 100));
      const offset = Number(q.get('pageToken') ?? 0);
      const page = matches.slice(offset, offset + size);
      const next = offset + size < matches.length ? String(offset + size) : undefined;
      return json(200, { ...(page.length ? { messages: page.map((m) => ({ id: m.id, threadId: m.id })) } : {}), resultSizeEstimate: matches.length, ...(next ? { nextPageToken: next } : {}) });
    }
    const one = /^messages\/(.+)$/.exec(path);
    if (one) {
      this.calls.push(`get ${b.address}`);
      const m = b.messages.find((x) => x.id === decodeURIComponent(one[1]));
      if (!m) return json(404, { error: { status: 'NOT_FOUND' } });
      const parts = [
        ...(m.text !== undefined ? [{ mimeType: 'text/plain', body: { data: encodeBase64Url(m.text), size: m.text.length } }] : []),
        ...(m.html !== undefined ? [{ mimeType: 'text/html', body: { data: encodeBase64Url(m.html), size: m.html.length } }] : []),
      ];
      return json(200, {
        id: m.id,
        threadId: m.id,
        labelIds: m.labels ?? ['INBOX'],
        internalDate: String(m.at),
        payload: { mimeType: 'multipart/alternative', headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }], parts },
      });
    }
    return json(404, { error: { status: 'NOT_FOUND' } });
  }
}

/** The kit's searches: `after:<seconds>` and `newer_than:`, then any of from:(x), "phrase", label:x. */
function matchesSearch(m: Stored, q: string): boolean {
  const after = /after:(\d+)/.exec(q);
  if (after && m.at <= Number(after[1]) * 1000) return false;
  const inner = /\((.*)\)\s*$/.exec(q)?.[1] ?? '';
  const terms = inner.split(' OR ').map((t) => t.trim()).filter(Boolean);
  const text = `${m.subject}\n${m.text ?? ''}\n${m.html ?? ''}`.toLowerCase();
  return terms.some((t) => {
    const from = /^from:\((.+)\)$/.exec(t);
    if (from) return m.from.toLowerCase().includes(from[1]);
    const label = /^label:(.+)$/.exec(t);
    if (label) return (m.labels ?? []).some((l) => l.toLowerCase().replace(/[\s/]+/g, '-') === label[1]);
    const phrase = /^"(.+)"$/.exec(t);
    return phrase ? text.includes(phrase[1].toLowerCase()) : false;
  });
}
