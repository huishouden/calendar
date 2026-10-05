# Changelog

## 0.2.1 (2026-10-05)

### Performance

* A sync or feed build reads only what changed: each list is kept in D1 (sealed, keyed by its query) and checked with one aggregation of count and sum of `updatedAt`; a change to an admin's or member's shared list reads only newer documents, a deletion or a filtered list the whole list, and every copy is read whole once a day. A load with nothing changed costs 4 reads instead of every document (~115 in a busy household).
* A quiet household is read every 15 minutes: Google's side is still checked every 5, the household's side every 5 only while it changed in the last hour. A first change after a quiet spell reaches Google within 15 minutes. The read budget counts 6 billed reads a check and keeps 5-minute checks for ~23 Google people within `FIRESTORE_CHECK_READS = 20000` (was 13).

## 0.2.0 (2026-10-05)

### Features

* A Health appointment in the feed and Google Calendar reads "Appointment for Ana" unless the reader turns on Health details, which add its kind, doctor, place and what to bring; its notes never leave the app (pwa-kit 0.101.0).

### Tests

* `bun run test` runs in the Firestore emulator (it was `test:emulator`), so `hh dev verify` runs the tests as CI does.
