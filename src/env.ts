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
  /** Space-separated origins the portal's Calendar page calls from. */
  ALLOWED_ORIGINS: string;
  /** The Google calendar's name: "Huishouden". */
  CALENDAR_NAME?: string;
  /** Firestore's REST base, for the emulator in tests and `wrangler dev`; production leaves it out. */
  FIRESTORE_URL?: string;
}

/** `fetch`, or a stand-in in tests. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
