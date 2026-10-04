-- Alert inboxes read with confidence (huishouden/pwa-kit readAlert): what each read message became,
-- the emails the member is asked about, the last import (for "Last import: N added, M need review"
-- and "Undo last import"), re-reading past imports when the parser changes, and the shape of the
-- emails read (never their content) so new alert formats can be supported.

-- What a read message became: imported, duplicate, skipped (not a purchase), review, and the
-- member's answers: dismissed (not a purchase), entered (they added it), undone (Undo last import).
-- NULL for messages read before this. `import_id`: the import that wrote it. `parsed`: the parser
-- version (src/mail/recheck.ts PARSER_VERSION) that last read it.
ALTER TABLE inbox_seen ADD COLUMN state TEXT;
ALTER TABLE inbox_seen ADD COLUMN import_id TEXT;
ALTER TABLE inbox_seen ADD COLUMN parsed INTEGER NOT NULL DEFAULT 0;

-- The last import that read anything: its id (on the transactions it wrote, `importId`), when, how
-- many it added and how many need review; whether it is still going (more units), or was undone.
ALTER TABLE inboxes ADD COLUMN import_id TEXT;
ALTER TABLE inboxes ADD COLUMN import_at INTEGER;
ALTER TABLE inboxes ADD COLUMN import_added INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inboxes ADD COLUMN import_review INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inboxes ADD COLUMN import_open INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inboxes ADD COLUMN import_undone INTEGER NOT NULL DEFAULT 0;
-- The parser version past imports were re-read with: below the current one, the checker re-reads
-- them (src/mail/recheck.ts) and corrects what it wrote.
ALTER TABLE inboxes ADD COLUMN rechecked INTEGER NOT NULL DEFAULT 0;

-- Emails that looked like purchases but couldn't be read: the member who connected the inbox sees
-- each one's subject (sealed here for `review:<inbox>`) and date, and says "Not a purchase" or
-- enters it. Deleted with the inbox, or once answered.
CREATE TABLE inbox_review (
  inbox TEXT NOT NULL,
  msg TEXT NOT NULL,
  import_id TEXT,
  subject TEXT NOT NULL,
  sent INTEGER NOT NULL,
  day TEXT NOT NULL,
  amount REAL,
  reason TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (inbox, msg)
);

-- The shape of each email read: the sender's address, the subject and the lines that carry an
-- amount or purchase wording with every word outside a fixed alert vocabulary masked (no merchant,
-- name, number or address survives), whether it was sent to a list, and what the parser made of it.
-- For supporting new alert formats. Kept 14 days.
CREATE TABLE mail_shapes (
  inbox TEXT NOT NULL,
  msg TEXT NOT NULL,
  at INTEGER NOT NULL,
  sender TEXT NOT NULL,
  subject TEXT NOT NULL,
  bulk INTEGER NOT NULL,
  lines TEXT NOT NULL,
  outcome TEXT NOT NULL,
  PRIMARY KEY (inbox, msg)
);
