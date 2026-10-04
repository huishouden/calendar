import type { GoogleEvent } from '../../src/google/api';

/**
 * A stand-in for Google's OAuth token endpoint and Calendar API, enough for the sync: calendars,
 * events with ids, PUT/PATCH/DELETE, instances of a series by `<master>_<original>`, `events.list`
 * with sync tokens and deletions, and the multipart batch endpoint. Etags and `updated` change on
 * every write, as Google's do. `user*` methods are a person editing in Google's own app.
 */

interface Stored extends GoogleEvent {
  seq: number;
}

interface Cal {
  summary: string;
  timeZone: string;
  description?: string;
  colour?: string;
  events: Map<string, Stored>;
}

const json = (status: number, body: unknown) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export class FakeGoogle {
  seq = 0;
  calendars = new Map<string, Cal>();
  revoked = new Set<string>();
  /** Every request, method and path (batches counted once, and their parts listed). */
  calls: string[] = [];
  account = 'alice@example.com';
  /** Answer the next `count` Calendar API requests (list, batch) with this error, as Google's rate limits do. */
  failNext: { status: number; reason: string; count: number } | null = null;

  private failing(): Response | null {
    if (!this.failNext || this.failNext.count <= 0) return null;
    this.failNext.count--;
    return json(this.failNext.status, { error: { code: this.failNext.status, message: 'Rate Limit Exceeded', errors: [{ reason: this.failNext.reason }] } });
  }
  private refreshCount = 0;

  constructor(private readonly clock: () => number) {}

  private bump(e: Partial<Stored>): void {
    this.seq++;
    e.seq = this.seq;
    e.etag = `"e${this.seq}"`;
    e.updated = new Date(this.clock()).toISOString();
  }

  cal(id: string): Cal {
    const c = this.calendars.get(id);
    if (!c) throw new Error(`no calendar ${id}`);
    return c;
  }

  /** The events as a person sees them in the calendar (not cancelled). */
  live(calendarId: string): Stored[] {
    return [...this.cal(calendarId).events.values()].filter((e) => e.status !== 'cancelled');
  }

  // ---- A person editing in Google ----

  userPatch(calendarId: string, id: string, patch: Partial<GoogleEvent>, at?: number): Stored {
    const e = this.cal(calendarId).events.get(id);
    if (!e) throw new Error(`no event ${id}`);
    Object.assign(e, patch);
    this.bump(e);
    if (at !== undefined) e.updated = new Date(at).toISOString();
    return e;
  }

  userDelete(calendarId: string, id: string): void {
    this.userPatch(calendarId, id, { status: 'cancelled' });
  }

  /** One occurrence of a series changed (or cancelled) in Google: an instance event appears. */
  userInstance(calendarId: string, masterId: string, suffix: string, patch: Partial<GoogleEvent>): Stored {
    const id = `${masterId}_${suffix}`;
    const events = this.cal(calendarId).events;
    const existing = events.get(id) ?? ({ id, recurringEventId: masterId, originalStartTime: originalOf(suffix), status: 'confirmed', seq: 0 } as Stored);
    Object.assign(existing, patch);
    events.set(id, existing);
    this.bump(existing);
    return existing;
  }

  // ---- HTTP ----

  async handle(url: string, init: RequestInit = {}): Promise<Response | null> {
    const method = (init.method ?? 'GET').toUpperCase();
    const u = new URL(url);
    if (u.hostname === 'oauth2.googleapis.com') return this.oauth(u, String(init.body ?? ''));
    if (u.href.startsWith('https://www.googleapis.com/batch/calendar/v3')) return this.failing() ?? this.batch(init);
    if (u.href.startsWith('https://www.googleapis.com/calendar/v3/')) {
      const refused = this.failing();
      if (refused) return refused;
      this.calls.push(`${method} ${u.pathname}`);
      const auth = new Headers(init.headers).get('Authorization');
      if (!auth?.startsWith('Bearer g-access')) return json(401, { error: { message: 'Invalid Credentials' } });
      const body = typeof init.body === 'string' && init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      return this.api(method, u.pathname.replace('/calendar/v3', '') + u.search, body);
    }
    return null;
  }

  private oauth(u: URL, body: string): Response {
    if (u.pathname === '/revoke') {
      this.revoked.add(u.searchParams.get('token') ?? '');
      return json(200, {});
    }
    const p = new URLSearchParams(body);
    if (p.get('grant_type') === 'authorization_code') {
      const code = p.get('code');
      if (code === 'bad-code') return json(400, { error: 'invalid_grant' });
      // Codes "gmail-<name>" are an alert inbox's account (test/helpers/gmail.ts); "gmail-denied" has Gmail unticked.
      const gmail = code?.startsWith('gmail-');
      const scope = code === 'no-calendar' || code === 'gmail-denied' ? 'openid email' : gmail ? 'https://www.googleapis.com/auth/gmail.readonly' : 'openid email https://www.googleapis.com/auth/calendar.app.created';
      const id = `${btoa(JSON.stringify({ alg: 'none' }))}.${btoa(JSON.stringify({ email: this.account })).replace(/=+$/, '')}.`;
      // An access token names its grant after "~", so the fake Gmail knows whose mailbox it is.
      return json(200, { access_token: `g-access-1~g-refresh-${code}`, refresh_token: `g-refresh-${code}`, expires_in: 3599, scope, ...(gmail ? {} : { id_token: id }) });
    }
    if (p.get('grant_type') === 'refresh_token') {
      if (this.revoked.has(p.get('refresh_token') ?? '')) return json(400, { error: 'invalid_grant' });
      this.refreshCount++;
      return json(200, { access_token: `g-access-${this.refreshCount + 1}~${p.get('refresh_token')}`, expires_in: 3599, scope: 'https://www.googleapis.com/auth/calendar.app.created' });
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  private api(method: string, path: string, body?: Record<string, unknown>): Response {
    const [pathname, search = ''] = path.split('?');
    const q = new URLSearchParams(search);
    const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] === 'calendars' && parts.length === 1 && method === 'POST') {
      const id = `cal${this.calendars.size + 1}@group.calendar.google.com`;
      this.calendars.set(id, { summary: String(body?.summary), timeZone: String(body?.timeZone), description: String(body?.description ?? ''), events: new Map() });
      return json(200, { id, summary: body?.summary });
    }
    if (parts[0] === 'users' && parts[2] === 'calendarList') {
      const c = this.calendars.get(parts[3]);
      if (!c) return json(404, { error: { message: 'Not Found' } });
      c.colour = String(body?.backgroundColor ?? '');
      return json(200, {});
    }
    if (parts[0] !== 'calendars') return json(404, {});
    const cal = this.calendars.get(parts[1]);
    if (parts.length === 2) {
      if (!cal) return json(404, { error: { message: 'Not Found' } });
      if (method === 'DELETE') {
        this.calendars.delete(parts[1]);
        return json(204, null);
      }
      return json(200, { id: parts[1], summary: cal.summary });
    }
    if (!cal) return json(404, { error: { message: 'Not Found' } });
    const events = cal.events;
    if (parts.length === 3 && method === 'GET') {
      const token = q.get('syncToken');
      if (token && !/^sync-\d+$/.test(token)) return json(410, { error: { message: 'Sync token is no longer valid' } });
      const since = token ? Number(token.slice(5)) : -1;
      const items = [...events.values()].filter((e) => e.seq > since && (token || q.get('showDeleted') === 'true' || e.status !== 'cancelled'));
      return json(200, { items: items.map(({ seq: _s, ...e }) => e), nextSyncToken: `sync-${this.seq}` });
    }
    if (parts.length === 3 && method === 'POST') {
      const id = String(body?.id);
      if (events.has(id)) return json(409, { error: { message: 'The requested identifier already exists.' } });
      const e = { ...(body as object), id, status: (body?.status as Stored['status']) ?? 'confirmed', seq: 0 } as Stored;
      events.set(id, e);
      this.bump(e);
      return json(200, strip(e));
    }
    const id = parts[3];
    const e = events.get(id);
    if (method === 'PUT') {
      if (!e) return json(404, { error: { message: 'Not Found' } });
      const next = { ...(body as object), id, status: (body?.status as Stored['status']) ?? 'confirmed', seq: 0 } as Stored;
      events.set(id, next);
      this.bump(next);
      return json(200, strip(next));
    }
    if (method === 'PATCH') {
      const instance = id.includes('_');
      if (!e && !instance) return json(404, { error: { message: 'Not Found' } });
      const [master, suffix] = id.split('_');
      if (instance && !events.has(master)) return json(404, { error: { message: 'Not Found' } });
      const next = (e ?? { id, recurringEventId: master, originalStartTime: originalOf(suffix), seq: 0 }) as Stored;
      Object.assign(next, body);
      events.set(id, next);
      this.bump(next);
      return json(200, strip(next));
    }
    if (method === 'DELETE') {
      if (!e) return json(404, { error: { message: 'Not Found' } });
      if (e.status === 'cancelled') return json(410, { error: { message: 'Resource has been deleted' } });
      e.status = 'cancelled';
      this.bump(e);
      return json(204, null);
    }
    if (method === 'GET') return e ? json(200, strip(e)) : json(404, {});
    return json(405, {});
  }

  private async batch(init: RequestInit): Promise<Response> {
    this.calls.push('POST /batch');
    const type = new Headers(init.headers).get('Content-Type') ?? '';
    const boundary = /boundary=([^;]+)/.exec(type)![1];
    const text = String(init.body);
    const out: string[] = [];
    for (const part of text.split(`--${boundary}`)) {
      const id = /Content-ID: <item(\d+)>/.exec(part);
      if (!id) continue;
      const line = /(GET|POST|PUT|PATCH|DELETE) (\/calendar\/v3\S*) HTTP\/1\.1/.exec(part)!;
      const bodyAt = part.indexOf('\r\n\r\n', part.indexOf(line[0]));
      const raw = bodyAt < 0 ? '' : part.slice(bodyAt + 4).trim();
      this.calls.push(`  ${line[1]} ${line[2].split('?')[0]}`);
      const res = this.api(line[1], line[2].replace('/calendar/v3', ''), raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined);
      const body = await res.text();
      out.push(`--resp_b\r\nContent-Type: application/http\r\nContent-ID: <response-item${id[1]}>\r\n\r\nHTTP/1.1 ${res.status} X\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${body}\r\n`);
    }
    return new Response(`${out.join('')}--resp_b--\r\n`, { status: 200, headers: { 'Content-Type': 'multipart/mixed; boundary=resp_b' } });
  }
}

const strip = ({ seq: _s, ...e }: Stored) => e;

function originalOf(suffix: string): { date?: string; dateTime?: string } {
  if (/^\d{8}$/.test(suffix)) return { date: `${suffix.slice(0, 4)}-${suffix.slice(4, 6)}-${suffix.slice(6, 8)}` };
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(suffix)!;
  return { dateTime: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` };
}
