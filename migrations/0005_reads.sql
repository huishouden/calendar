-- Fewer Firestore reads (src/lists.ts, src/check.ts).
-- Each list a calendar is built from, as last read, sealed for its key (a hash of household,
-- collection and whose view): a load reads from Firestore only what changed since.
CREATE TABLE lists (
  key TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  -- When the copy was last read whole: a day later it is read whole again.
  at INTEGER NOT NULL,
  -- When a load last used it: copies unused for a week are deleted.
  used_at INTEGER NOT NULL
);
CREATE INDEX lists_used ON lists (used_at);

-- What the household side of the person's last check came to, and when it last changed: a quiet
-- household is checked every 15 minutes instead of every 5.
ALTER TABLE people ADD COLUMN hh_signal TEXT;
ALTER TABLE people ADD COLUMN hh_signal_at INTEGER;
