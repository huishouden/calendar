import { globalFetch, type Fetch } from '../env';

/**
 * The Google Calendar API calls the sync makes, with one access token. Writes go in batches of up
 * to 50 (one HTTP request each, Google's batch endpoint), which keeps a run inside the Worker's
 * subrequest budget.
 */

export const API = 'https://www.googleapis.com/calendar/v3';
export const BATCH_URL = 'https://www.googleapis.com/batch/calendar/v3';
export const BATCH_SIZE = 50;

export class CalendarApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Google's reason (`rateLimitExceeded`, `forbidden`, ...), when it gave one. */
    readonly reason = '',
  ) {
    super(message);
  }
}

/** Google's reasons for "slow down": a 429, or a 403 that is about rates or quota, not access. */
const RATE_REASONS = /rateLimit|quotaExceeded|usageLimits|dailyLimit/i;

export function rateLimited(status: number, reason = ''): boolean {
  return status === 429 || (status === 403 && RATE_REASONS.test(reason));
}

export const isRateLimited = (e: unknown): boolean => e instanceof CalendarApiError && rateLimited(e.status, e.reason);

/** The reason in a Calendar API error body (`error.errors[0].reason`, or `error.status`). */
export function reasonOf(body: unknown): string {
  const error = (body as { error?: { errors?: { reason?: string }[]; status?: string } } | null)?.error;
  return error?.errors?.[0]?.reason ?? error?.status ?? '';
}

/** A sync token Google no longer accepts (410): list everything again. */
export class SyncTokenGone extends Error {}

export interface GoogleDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface GoogleEvent {
  id: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  etag?: string;
  /** RFC 3339. */
  updated?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleDateTime;
  end?: GoogleDateTime;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: GoogleDateTime;
  extendedProperties?: { private?: Record<string, string> };
  iCalUID?: string;
}

export interface BatchRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Under the API: `/calendars/{id}/events`. */
  path: string;
  body?: unknown;
}

export interface BatchResponse {
  status: number;
  body: Record<string, unknown> | null;
}

const enc = encodeURIComponent;

export class Calendar {
  /** HTTP requests made, for the run's subrequest budget. */
  requests = 0;

  constructor(
    private readonly token: string,
    private readonly fetchImpl: Fetch = globalFetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    this.requests++;
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    const parsed = (text ? JSON.parse(text) : {}) as T;
    return { status: res.status, body: parsed };
  }

  private static fail(what: string, status: number, body: unknown): CalendarApiError {
    const message = (body as { error?: { message?: string } })?.error?.message ?? '';
    return new CalendarApiError(status, `[${status}] Calendar ${what}${message ? `: ${message}` : ''}`, reasonOf(body));
  }

  async createCalendar(summary: string, description: string, timeZone: string): Promise<string> {
    const { status, body } = await this.call<{ id?: string }>('POST', '/calendars', { summary, description, timeZone });
    if (status !== 200 || !body.id) throw Calendar.fail('create calendar', status, body);
    return body.id;
  }

  /** Its colour in the person's list (RGB, so it matches the suite's green). Best effort. */
  async colour(calendarId: string, background: string, foreground = '#ffffff'): Promise<void> {
    await this.call('PATCH', `/users/me/calendarList/${enc(calendarId)}?colorRgbFormat=true`, { backgroundColor: background, foregroundColor: foreground, selected: true }).catch(() => undefined);
  }

  /** Whether the calendar still exists (the person may have deleted it in Google). */
  async calendarExists(calendarId: string): Promise<boolean> {
    const { status, body } = await this.call('GET', `/calendars/${enc(calendarId)}`);
    if (status === 404 || status === 410) return false;
    if (status !== 200) throw Calendar.fail('get calendar', status, body);
    return true;
  }

  async deleteCalendar(calendarId: string): Promise<void> {
    const { status, body } = await this.call('DELETE', `/calendars/${enc(calendarId)}`);
    if (status !== 204 && status !== 200 && status !== 404 && status !== 410) throw Calendar.fail('delete calendar', status, body);
  }

  /**
   * Events changed since `syncToken` (with deletions), or every event without one; at most
   * `maxPages` pages of 250. `nextSyncToken` is only there once the last page was read.
   */
  async changes(calendarId: string, syncToken: string | null, maxPages = 4): Promise<{ items: GoogleEvent[]; nextSyncToken?: string; complete: boolean }> {
    const items: GoogleEvent[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const q = new URLSearchParams({ maxResults: '250', showDeleted: 'true' });
      if (syncToken) q.set('syncToken', syncToken);
      if (pageToken) q.set('pageToken', pageToken);
      const { status, body } = await this.call<{ items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string }>('GET', `/calendars/${enc(calendarId)}/events?${q}`);
      if (status === 410) throw new SyncTokenGone('Sync token expired');
      if (status !== 200) throw Calendar.fail('list events', status, body);
      items.push(...(body.items ?? []));
      if (!body.nextPageToken) return { items, nextSyncToken: body.nextSyncToken, complete: true };
      pageToken = body.nextPageToken;
    }
    return { items, complete: false };
  }

  /** Many writes, 50 to a request; answers in the same order. */
  async batch(requests: BatchRequest[]): Promise<BatchResponse[]> {
    const out: BatchResponse[] = [];
    for (let i = 0; i < requests.length; i += BATCH_SIZE) out.push(...(await this.batchOnce(requests.slice(i, i + BATCH_SIZE))));
    return out;
  }

  private async batchOnce(requests: BatchRequest[]): Promise<BatchResponse[]> {
    if (requests.length === 0) return [];
    this.requests++;
    const boundary = `batch_huishouden_${crypto.randomUUID().replace(/-/g, '')}`;
    const res = await this.fetchImpl(BATCH_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': `multipart/mixed; boundary=${boundary}` },
      body: batchBody(boundary, requests),
    });
    const text = await res.text();
    if (!res.ok) throw Calendar.fail('batch', res.status, safeJson(text));
    const type = res.headers.get('Content-Type') ?? '';
    const answer = /boundary=("?)([^";]+)\1/.exec(type)?.[2];
    if (!answer) throw new CalendarApiError(res.status, 'Calendar batch: no boundary in the answer');
    return parseBatch(text, answer, requests.length);
  }
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** The multipart/mixed body of a batch: one `application/http` part per request. */
export function batchBody(boundary: string, requests: BatchRequest[]): string {
  const parts = requests.map((r, i) => {
    const head = [`--${boundary}`, 'Content-Type: application/http', `Content-ID: <item${i + 1}>`, '', `${r.method} /calendar/v3${r.path} HTTP/1.1`];
    if (r.body === undefined) return [...head, '', ''].join('\r\n');
    return [...head, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(r.body)].join('\r\n');
  });
  return `${parts.join('\r\n')}\r\n--${boundary}--\r\n`;
}

/** The answers of a batch, by each part's `Content-ID: <response-itemN>`. A missing one is a 500. */
export function parseBatch(text: string, boundary: string, count: number): BatchResponse[] {
  const out: BatchResponse[] = Array.from({ length: count }, () => ({ status: 500, body: null }));
  for (const part of text.split(`--${boundary}`)) {
    const id = /Content-ID:\s*<response-item(\d+)>/i.exec(part);
    if (!id) continue;
    const index = Number(id[1]) - 1;
    const http = /HTTP\/1\.1 (\d{3})[^\r\n]*\r?\n([\s\S]*)$/.exec(part);
    if (!http || index < 0 || index >= count) continue;
    const rest = http[2];
    const split = rest.search(/\r?\n\r?\n/);
    const body = split < 0 ? '' : rest.slice(split).trim();
    out[index] = { status: Number(http[1]), body: body ? (safeJson(body) as Record<string, unknown> | null) : null };
  }
  return out;
}
