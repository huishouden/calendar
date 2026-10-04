import type { GmailApiMessage } from '@huishouden/pwa-kit/mail-core';
import type { Fetch } from '../env';

/**
 * The Gmail API calls the alert checker makes, read-only (`gmail.readonly`): the account's address
 * and history id, what arrived since a history id (`users.history.list`), a search
 * (`users.messages.list`), and one message (`users.messages.get`). Errors carry Google's status and
 * reason, never a message's content.
 */

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export class GmailApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`[${status}] ${reason}`);
  }
}

/** The history id is older than Gmail keeps (about a week): search instead. */
export class HistoryGone extends Error {}

/** Google said too many requests: 429, or 403 with a rate or quota reason. */
export const gmailRateLimited = (e: unknown): boolean => e instanceof GmailApiError && (e.status === 429 || (e.status === 403 && /rate|quota/i.test(e.reason)));

/** History pages read per check: 500 records each, so a check reads up to 1,500 new messages' worth. */
const HISTORY_PAGES = 3;

export class Gmail {
  /** Requests made, for the invocation's subrequest budget. */
  calls = 0;

  constructor(
    private readonly token: string,
    private readonly fetchImpl: Fetch,
  ) {}

  private async call<T>(path: string, params: Record<string, string | string[]> = {}): Promise<T> {
    const url = new URL(`${API}/${path}`);
    for (const [k, v] of Object.entries(params)) for (const one of Array.isArray(v) ? v : [v]) url.searchParams.append(k, one);
    this.calls++;
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${this.token}` } });
    } catch {
      throw new GmailApiError(0, 'unreachable');
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { status?: string; errors?: { reason?: string }[] } };
      throw new GmailApiError(res.status, (body.error?.errors?.[0]?.reason ?? body.error?.status ?? 'error').slice(0, 40));
    }
    return (await res.json()) as T;
  }

  async profile(): Promise<{ address: string; historyId: string }> {
    const p = await this.call<{ emailAddress?: string; historyId?: string }>('profile');
    return { address: (p.emailAddress ?? '').toLowerCase(), historyId: p.historyId ?? '' };
  }

  /**
   * How many messages arrived since `start` (drafts and sent mail left out), and the history id to
   * ask from next time. Throws `HistoryGone` when Gmail no longer has `start`.
   */
  async history(start: string): Promise<{ added: number; historyId: string; complete: boolean }> {
    let added = 0;
    let historyId = start;
    let pageToken: string | undefined;
    for (let page = 0; page < HISTORY_PAGES; page++) {
      let r: { history?: { messagesAdded?: { message?: { labelIds?: string[] } }[] }[]; historyId?: string; nextPageToken?: string };
      try {
        r = await this.call('history', { startHistoryId: start, historyTypes: 'messageAdded', maxResults: '500', ...(pageToken ? { pageToken } : {}) });
      } catch (e) {
        if (e instanceof GmailApiError && e.status === 404) throw new HistoryGone();
        throw e;
      }
      for (const h of r.history ?? []) {
        for (const m of h.messagesAdded ?? []) {
          const labels = m.message?.labelIds ?? [];
          if (!labels.includes('DRAFT') && !(labels.includes('SENT') && !labels.includes('INBOX'))) added++;
        }
      }
      if (r.historyId) historyId = r.historyId;
      pageToken = r.nextPageToken;
      if (!pageToken) return { added, historyId, complete: true };
    }
    // More than the pages read: report what was seen; the search covers the rest.
    return { added: Math.max(added, 1), historyId, complete: false };
  }

  /** Message ids matching a search, newest first, at most `max`. */
  async search(q: string, max = 100): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const r = await this.call<{ messages?: { id: string }[]; nextPageToken?: string }>('messages', { q, maxResults: String(Math.min(100, max - ids.length)), ...(pageToken ? { pageToken } : {}) });
      ids.push(...(r.messages ?? []).map((m) => m.id));
      pageToken = r.nextPageToken;
    } while (pageToken && ids.length < max);
    return ids.slice(0, max);
  }

  get(id: string): Promise<GmailApiMessage> {
    return this.call<GmailApiMessage>(`messages/${encodeURIComponent(id)}`, { format: 'full' });
  }
}
