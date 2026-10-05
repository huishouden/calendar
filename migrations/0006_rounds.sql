-- A feed build or a sync round in small units (src/round.ts), each its own invocation within the
-- free plan's 10 ms of CPU. Where the person's round is and what it has worked out so far, sealed
-- for `round:<pid>` (src/seal.ts), kept on their row: written with the lease's release, read with
-- the lease, so a unit costs no D1 call of its own for it.
ALTER TABLE people ADD COLUMN round TEXT;
-- 1 = feed, 2 = sync (src/work.ts FEED, SYNC).
ALTER TABLE people ADD COLUMN round_kind INTEGER;
-- When the round started: one older than ROUND_MAX_MS starts again.
ALTER TABLE people ADD COLUMN round_at INTEGER;
-- The lists' counts and sums of `updatedAt` the check that marked the work asked (JSON, no
-- content): the round's first unit reads the lists by them instead of asking again.
ALTER TABLE people ADD COLUMN hh_counts TEXT;

-- What a round hands from one unit to the next when it is too big for the row, sealed for
-- `round:<pid>`: the lists cut into parts to export ('in'), the feed's events as iCalendar text
-- ('ics'), the writes for Google ('write', a unit's worth a row, deletions first).
CREATE TABLE round_items (
  pid TEXT NOT NULL,
  part TEXT NOT NULL,
  seq INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (pid, part, seq)
);
