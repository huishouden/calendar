-- The Firestore reads the person's last finished (or stopped) round was billed for, and when
-- (src/budget.ts). Kept here, behind D1's access, rather than in the logs: a round reading too much
-- is found with `SELECT pid, round_reads, round_reads_at FROM people ORDER BY round_reads DESC`.
ALTER TABLE people ADD COLUMN round_reads INTEGER;
ALTER TABLE people ADD COLUMN round_reads_at INTEGER;
