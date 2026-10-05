/** The Worker's bindings and settings (wrangler.toml; secrets with `wrangler secret put`). */
export interface Env {
  /** Sealed records: each person's tokens, each feed secret's owner (src/store.ts). */
  TOKENS: KVNamespace;
  /** Sync state (migrations/). */
  DB: D1Database;
  FIREBASE_PROJECT_ID: string;
  FIREBASE_API_KEY: string;
  GOOGLE_CLIENT_ID: string;
  /** Secret. Without it Google Calendar sync is off; the feed still works. */
  GOOGLE_CLIENT_SECRET?: string;
  /** Secret: 32 random bytes, base64. */
  SEAL_KEY: string;
  SITE_URL: string;
  /**
   * Space-separated pages Google may send a person back to with a code ("Continue in this tab"):
   * each also an Authorized redirect URI of the OAuth client. Unset: the popup only (`postmessage`).
   */
  GOOGLE_REDIRECT_URIS?: string;
  /** Space-separated origins the portal's Calendar page calls from. */
  ALLOWED_ORIGINS: string;
  /** The Google calendar's name: "Huishouden". */
  CALENDAR_NAME?: string;
  /** The work queue (src/work.ts, src/mail/work.ts): one message per person or alert inbox with work. Optional: the cron runs work without it. */
  WORK?: Queue<{ pid: string } | { inbox: string }>;
  /** This Worker's own `Fanout` entrypoint (src/index.ts): each call is its own invocation, with its own CPU time and subrequests. */
  SELF?: FanoutRpc;
  /**
   * Firestore reads a day the checks may use (src/tick.ts `periodsFor`): they check less often
   * rather than go over it. Unset: no limit (a project on the Blaze plan).
   */
  FIRESTORE_CHECK_READS?: string;
  /** Extra roots for the minute's checks (src/ticker.ts): each Ticker's alarm is its own top-level invocation. */
  TICKER?: DurableObjectNamespace<TickerRpc>;
  /** Firestore's REST base, for the emulator in tests and `wrangler dev`; production leaves it out. */
  FIRESTORE_URL?: string;
}

/** `fetch`, or a stand-in in tests. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The runtime's `fetch`, called unbound. Workers throws `TypeError: Illegal invocation` when `fetch`
 * is called as a method (`this.fetchImpl(...)`), so it is never stored bare as a default.
 */
export const globalFetch: Fetch = (url, init) => fetch(url, init);

/** What the cron fans out to (src/index.ts `Fanout`), and the queue's next unit. */
export interface FanoutRpc {
  /** `googleEvery`: the cron's minutes between Google people's checks (src/check.ts `householdDue`). */
  check(pids: string[], googleEvery?: number): Promise<import('./check').CheckTotals>;
  /** `handover`: what the unit before handed on (src/work.ts `Handover`). */
  work(pid: string, handover?: import('./work').Handover): Promise<import('./work').WorkOutcome>;
  /** Spending's alert inboxes: a few checked (src/mail/check.ts), and one unit of an inbox's import (src/mail/work.ts). */
  mail(ids: string[]): Promise<import('./mail/check').MailTotals>;
  mailWork(id: string): Promise<import('./work').WorkOutcome>;
}

/** A Ticker Durable Object (src/ticker.ts): told its part, it checks that share of every minute from its alarm. */
export interface TickerRpc extends Rpc.DurableObjectBranded {
  arm(part: number): Promise<void>;
}
