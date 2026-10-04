-- Scale-out (README, "Many households"): the person's sealed record moves from KV to D1 (KV's free
-- tier allows 100,000 reads a day; the checks read every record every few minutes), each person
-- gets a fixed check slot, and work found by a check is marked here and sent to the queue.

-- The person's record, sealed for `person:<pid>` (src/seal.ts), as KV held it.
ALTER TABLE people ADD COLUMN record TEXT;
-- 0..59 from the pid (src/store.ts `shardOf`): the minutes of the hour the person is checked in.
ALTER TABLE people ADD COLUMN shard INTEGER NOT NULL DEFAULT 0;
-- A hash of the household: a household's members are checked together and share its reads.
ALTER TABLE people ADD COLUMN hh TEXT;
-- Work a check found: 1 = rebuild the feed, 2 = sync Google. Cleared by the work that did it.
ALTER TABLE people ADD COLUMN work INTEGER NOT NULL DEFAULT 0;
-- When a queue message was sent for the work (one at a time per person).
ALTER TABLE people ADD COLUMN queued_at INTEGER;
-- Held by the one run working for the person (per-person ordering).
ALTER TABLE people ADD COLUMN lease_until INTEGER;
-- Google said too many requests (429, or 403 rate limit): nothing for this person until then.
ALTER TABLE people ADD COLUMN backoff_until INTEGER;
ALTER TABLE people ADD COLUMN backoff INTEGER NOT NULL DEFAULT 0;

UPDATE people SET shard = (unicode(substr(pid, 1, 1)) * 64 + unicode(substr(pid, 2, 1))) % 60;
CREATE INDEX people_shard ON people (shard);
CREATE INDEX people_work ON people (work) WHERE work != 0;

-- The precomputed feed, by a hash of its secret (the URL), sealed for `ics:<secret>`: only a request
-- with the URL can open it. Built by the work (src/work.ts), never by a request.
DROP TABLE feeds;
CREATE TABLE feeds (
  id TEXT PRIMARY KEY,
  pid TEXT NOT NULL,
  -- The change signal it was built from (src/person.ts).
  signal TEXT NOT NULL,
  etag TEXT NOT NULL,
  body TEXT NOT NULL,
  built_at INTEGER NOT NULL,
  -- Set by a request when the body is older than FEED_MAX_AGE: the next check rebuilds it.
  stale INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX feeds_pid ON feeds (pid);

-- When each minute of the hour's checks last all finished: the portal's "Updated ... ago" for
-- people checked in that minute, without a write per person per check.
CREATE TABLE ticks (
  minute INTEGER PRIMARY KEY,
  at INTEGER NOT NULL
);

-- Small switches: `firestore-pause` (Firestore said its quota is used up: no checks until then).
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
