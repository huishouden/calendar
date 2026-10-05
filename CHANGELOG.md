# Changelog

## 0.2.0 (2026-10-05)

### Features

* A Health appointment in the feed and Google Calendar reads "Appointment for Ana" unless the reader turns on Health details, which add its kind, doctor, place and what to bring; its notes never leave the app (pwa-kit 0.101.0).

### Tests

* `bun run test` runs in the Firestore emulator (it was `test:emulator`), so `hh dev verify` runs the tests as CI does.
