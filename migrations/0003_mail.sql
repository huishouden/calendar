-- Spending's alert inboxes (src/mail/): Gmail accounts members connected so the household's card
-- alerts are read every few minutes, as the member who connected each. No addresses or emails in
-- the clear: the inbox's id is a hash, and who it belongs to, its Google grant and the household's
-- search are sealed.

CREATE TABLE inboxes (
  -- 'ib-' and a hash of household and address; also the Firestore document's id (spendingInboxes).
  id TEXT PRIMARY KEY,
  -- A hash of the household, for its status.
  hh TEXT NOT NULL,
  -- 0..59: the minutes of the hour the inbox is checked in.
  shard INTEGER NOT NULL,
  -- Sealed for `inbox:<id>`: household, the member (email, uid, Firebase refresh token), the Google
  -- refresh token, the address, the household's time zone.
  record TEXT NOT NULL,
  -- Sealed for `inbox-config:<id>`: the household's cards, labels and category rules and the Gmail
  -- search they make, read as the member at most every 12 hours (so a check reads no Firestore).
  config TEXT,
  config_at INTEGER,
  -- Gmail's history id after the last check: the next check asks only what arrived since.
  history_id TEXT,
  -- Every alert that arrived before this (ms) has been read; searches look after it (less a margin).
  since INTEGER NOT NULL,
  -- 1: a search and import is owed (first connect, history expired, Check now, more to read).
  pending INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER,
  -- The last import that added alerts, and how many.
  found_at INTEGER,
  added INTEGER,
  -- What stopped the last check: revoked (reconnect), not-member, nothing-to-search, gmail, firestore.
  error TEXT,
  queued_at INTEGER,
  lease_until INTEGER,
  backoff_until INTEGER,
  backoff INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX inboxes_shard ON inboxes (shard);
CREATE INDEX inboxes_hh ON inboxes (hh);
CREATE INDEX inboxes_pending ON inboxes (pending) WHERE pending != 0;

-- Messages already read for an inbox (alerts, payments, anything the search matched), so none is
-- read twice. Gmail message ids only. Kept 45 days.
CREATE TABLE inbox_seen (
  inbox TEXT NOT NULL,
  msg TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (inbox, msg)
);

-- When each minute's inbox checks last all ran: the app's "Updated ... ago" without a write per
-- inbox per check.
CREATE TABLE mail_ticks (
  minute INTEGER PRIMARY KEY,
  at INTEGER NOT NULL
);
