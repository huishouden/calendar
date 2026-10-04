-- One row per person using the calendar: `pid` is a hash of household and email, never the email.
CREATE TABLE people (
  pid TEXT PRIMARY KEY,
  feed INTEGER NOT NULL DEFAULT 0,
  google INTEGER NOT NULL DEFAULT 0,
  -- Google's events.list sync token for the person's Huishouden calendar.
  sync_token TEXT,
  -- What the person's agenda looked like at the last sync (counts and sums, src/person.ts).
  signal TEXT,
  full_at INTEGER,
  last_sync INTEGER,
  last_ok INTEGER,
  last_error TEXT,
  -- A line for the person: a change from Google that couldn't be applied.
  notice TEXT,
  counts TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX people_google ON people (google, last_sync);

-- Each Google event the sync wrote, by the export's stable key.
CREATE TABLE events (
  pid TEXT NOT NULL,
  key TEXT NOT NULL,
  event_id TEXT NOT NULL,
  -- The export's hash of what the event shows, and the zone it was written in.
  hash TEXT NOT NULL,
  -- Google's etag after our last write: the same etag in a change is our own write coming back.
  etag TEXT,
  -- JSON: moved occurrences we wrote, original day to instance etag.
  overrides TEXT,
  -- JSON: what we last wrote (titles, times, the series), to tell what a person changed in Google
  -- from what changed in the app meanwhile.
  written TEXT,
  -- The person deleted it in Google (a whole series, or something they may not cancel): not rewritten.
  hidden INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pid, key)
);
CREATE INDEX events_by_id ON events (pid, event_id);

-- The person's last feed, served again while nothing changed (ETag).
CREATE TABLE feeds (
  pid TEXT PRIMARY KEY,
  signal TEXT NOT NULL,
  etag TEXT NOT NULL,
  body TEXT NOT NULL,
  built_at INTEGER NOT NULL
);
