# calendar

The household in each person's own calendar. A Cloudflare Worker on the free plan offers two ways
in, and every person sets theirs up in the portal (Settings > Calendar):

- **A calendar feed**: a secret URL (`webcal://` or https) that Apple Calendar, Google Calendar,
  Outlook and any other calendar app subscribes to. It is read-only and refreshes as often as the
  calendar app checks.
- **Google Calendar sync**: a "Huishouden" calendar in the person's Google account, in the suite's
  green, kept in step every 5 minutes, both ways. Moving, renaming or deleting an event there changes
  the record in the app. Each change shows in the portal's history with Undo.

What a person sees is what they may see in the household, in their language, with their settings.
Helpers and kids get nothing private and no bills. Health items go only to the person, their carers
and the admins, and by default read "Medicine for Ana" with no detail, because calendars are often
shared.

The Worker acts **only as the person** with their own Firebase sign-in, so the household's Firestore
rules (huishouden/rules) decide every read and write, exactly as in the apps. It has no service
account.

## How it works

The model comes from `@huishouden/pwa-kit/calendar-export` (see the kit's
`docs/calendar-export.md`). It turns the agenda items and to-dos the person can read into calendar
events:

- one event per item;
- one repeating event per regular event (RRULE from the schedule, EXDATE for skipped days, overrides
  for moved ones);
- stable keys, and a hash of what each event shows.

| File | Does |
|---|---|
| `src/index.ts` | Routes: `/feed/<secret>.ics`, `/api/*`, and the 5-minute cron |
| `src/feed.ts` | The feed: the person's calendar, cached in D1 while nothing changed, `ETag`/304 |
| `src/api.ts` | The portal's calls: status, set up / rotate / revoke the feed, connect / sync / disconnect Google |
| `src/person.ts` | Acting as the person: their ID token on every Firestore call, their role and settings, the change signal |
| `src/sync.ts` | One person's Google sync: Google's changes, the household's, the writes in batches; the cron |
| `src/backsync.ts` | A change made in Google read as an edit and applied to the record as the person |
| `src/google/*` | OAuth (code exchange, refresh, revoke), the Calendar API with batching, event bodies and ids |
| `src/store.ts`, `src/seal.ts` | Sealed records in KV, sync state in D1 |

### Signing in as the person

The portal posts the signed-in person's Firebase refresh token to the Worker, with their Firebase
ID token, over CORS from the suite's own site only. The Worker checks that the refresh token is the
caller's own (Firebase Auth's token service says whose it is). After that, the Worker exchanges the
refresh token for ID tokens on each run (`@huishouden/pwa-kit/firebase-auth-rest`) and calls
Firestore over REST with them (`/firestore-rest`). This is the same way huishouden/connector acts.

### What is kept, and where

- **KV** holds two kinds of sealed record (AES-256-GCM, key derived with HKDF from the `SEAL_KEY`
  secret and the record's purpose):
  - the person's record: their refresh token, feed secret, Google refresh token and calendar id,
    language and time zone;
  - per feed secret, whose it is. This record is sealed with a key that also needs the secret from
    the URL, so the Worker's key alone can't open it.

  KV keys are hashes. Nothing in KV is readable without the secrets.
- **D1** holds the sync state, keyed by a hash of household and email:
  - which Google event stands for which agenda key;
  - the hash and a snapshot of what was written;
  - the etag our own write got back;
  - Google's sync token;
  - the last feed, served again while nothing changed.
- **Firestore** holds what the person chose (`calendarSettings/{email}`) and the history of changes
  from Google (`calendarChanges`), both readable only by that person. Tokens never go there.

### The feed

`GET /feed/<secret>.ics` (also `HEAD`). The secret finds the person, and the feed is worked out as
them. Before reading the agenda, the Worker asks Firestore for a **change signal**: for the agenda,
personal agenda, to-dos and personal to-dos, a count and a sum of `updatedAt` in one aggregation each.
Together with the person's role and settings, this tells whether anything they see changed.

- **Nothing changed**: the last feed comes back from D1 with the same `ETag`, or a 304 to a client
  that sent it.
- **Something changed**: the agenda is read and the feed is built again.

The feed asks to be refreshed hourly (`REFRESH-INTERVAL`, `X-PUBLISHED-TTL`: PT1H). If the
household can't be reached, the last feed is served rather than an empty calendar. Someone who
left the household gets a 404, and their feed is deleted.

### Google Calendar sync, both ways

Each run, for one person:

1. **Google's changes.** `events.list` with the stored sync token returns what changed in the
   Huishouden calendar, deletions included. A change whose etag is the one our own write got back
   is an **echo** and is dropped (loop prevention).
2. **The household's changes.** The change signal, as for the feed. If nothing changed on either
   side, the run ends after a handful of small requests.
3. **Changes from Google go back** (`src/backsync.ts`). Each agenda item an app publishes carries
   declarative edits (`edit` in `@huishouden/pwa-kit/agenda-core`): the writes on the app's own
   collections that move, retime, rename, re-note, skip or cancel it. A change in Google is
   measured against what the sync last wrote, then filled into the matching edit and written **as
   the person**, so the app's rules decide whether they may. The agenda item moves with it, and the
   change is added to their history with the writes that undo it, all in one atomic commit.

   | In Google | In the app |
   |---|---|
   | An event moved to another day or time | `reschedule` (the record's date and time) |
   | One occurrence of a series moved | `reschedule` of that occurrence (the regular event's change for that day) |
   | A series moved to another time of day, on the same days | `retime` |
   | A new title | `rename` (for a series, the whole series) |
   | Notes typed in the description | `notes` |
   | One occurrence of a series deleted | `skip` |
   | A one-off event deleted | `cancel` |
   | A whole series deleted | Taken out of this person's calendar only. The household keeps it. |

   Anything else, or anything the person may not change, is put back as the app has it on the
   next push. The portal then says that a change couldn't be applied. A change already in the app
   (a retried run) is no change. The history entry is created only if new, so a retried run can't
   apply a change twice.

   **Conflicts: last writer wins.** If the agenda item was updated after Google's change (its
   `updatedAt` against the event's `updated`), the app's version stands and is written to Google
   again.
4. **The difference goes to Google**, up to 50 writes in each batch request:
   - new events are inserted with ids made from the person and the key, so a retry can't make
     two;
   - changed events are rewritten (whole, recurrence included);
   - moved occurrences are patched as instances;
   - events no longer in the agenda are deleted.

   Each event carries the private property `huishouden` (`'<household>:<key>'`). The kit's calendar
   import skips such events, so nothing exported comes back as a suggestion.

A full rebuild happens at least every 6 hours anyway. Each run logs one line of counts. Logs never
hold titles, emails, households or tokens.

## Limits

- **Subscribed feeds refresh slowly in Google Calendar.** Google re-reads a subscribed URL on its
  own schedule, typically every 8 to 24 hours, and ignores `REFRESH-INTERVAL`. Apple Calendar
  follows the hourly hint (or its own setting); Outlook refreshes on its own schedule, every few hours. For Google, use
  the sync, which shows changes within about 5 minutes.
- **The sync runs every 5 minutes**, for about 3 people per run (the free plan's 50 subrequests).
  Each person costs about 12 requests: a token, the change list, four aggregations, two reads and
  the batches. People are taken longest-unsynced first, so with more people each waits a few runs.
  A busy run writes at most 200 events per person, and the rest go next run.
- **Firestore's free tier**: a check costs about 6 reads per person per run when nothing changed,
  about 1,700 a day each. A rebuild reads the person's agenda, a few hundred documents.
  When the project's daily quota is used up (Spark: 50,000 reads), Firestore answers 429 until
  midnight Pacific time: the portal's calls get 503 `firestore-quota` (the portal says so, rather than "couldn't reach") and
  feeds serve their last copy.
- **CPU**: measured on staging with about 50 events:
  - a feed rebuild takes 28 to 53 ms of CPU time;
  - a feed served from the cache, 8 ms;
  - a portal API call, 3 to 21 ms.

  Cloudflare reported each of these as `ok`. If the account's plan enforces a 10 ms per-request
  limit, a rebuild could be refused with error 1102. The calendar app would then retry later and
  get the cached feed once one exists. Most of the cost is the cold start: the zone data for the
  VTIMEZONE and the language catalogue load.
- **Ahead of the window**: apps publish 180 days ahead (Home's regular events 60). A repeating event
  carries on past that by its schedule. A skip or move further ahead shows once it is within the
  app's window.
- **Changes Google can't express in the app** (a series' days changed, a title changed on one
  occurrence, an event made all day where the app has times) are put back.
- **Google OAuth.** The scope is `https://www.googleapis.com/auth/calendar.app.created`: "Make
  secondary Google calendars, and see, create, change, and delete events on them". Google's narrowest
  calendar scope, it can't see any other calendar in the account. It covers `calendars.insert` and
  delete, `calendarList.patch` (the colour) and every `events` call on the calendar it made. Google
  doesn't publish this scope's sensitivity class. Its console shows the class when the scope is
  added to the consent screen.
  - If it is non-sensitive, no verification is needed.
  - If it is sensitive, an unverified app shows a warning screen and is limited to 100 users until
    Google verifies it. Verification is free and needs a privacy policy and a short video.

## One-time setup

All of it is done once for the whole suite, never per household.

```sh
bun install
# Storage (the ids are in wrangler.toml).
bunx wrangler d1 create huishouden-calendar
bunx wrangler kv namespace create huishouden-calendar
bun run deploy:staging && bun run deploy   # applies D1 migrations, then deploys
```

### Secrets

```sh
# A new sealing key, straight into each Worker (it is never written down):
bun run seal-key | bunx wrangler secret put SEAL_KEY
bun run seal-key | bunx wrangler secret put SEAL_KEY --env staging
```

The Firebase web API key (public, the portal's `VITE_FIREBASE_API_KEY` repository variable) is set
the same way, so the repo's leak scan needn't allow API keys:

```sh
gh variable get VITE_FIREBASE_API_KEY --repo huishouden/portal | bunx wrangler secret put FIREBASE_API_KEY
gh variable get STAGING_VITE_FIREBASE_API_KEY --repo huishouden/portal | bunx wrangler secret put FIREBASE_API_KEY --env staging
```

Replacing `SEAL_KEY` makes every stored token unreadable, and everyone sets up their feed and
Google sync again.

### Google Calendar sync

1. The web OAuth client is the one Firebase made for Google sign-in (`GOOGLE_CLIENT_ID` in
   `wrangler.toml`). Its secret goes into the Worker:

   ```sh
   # Production; for staging use huishouden-staging and --env staging.
   curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "x-goog-user-project: huishouden-piekstra" \
     https://identitytoolkit.googleapis.com/admin/v2/projects/huishouden-piekstra/defaultSupportedIdpConfigs/google.com \
     | python3 -c 'import json,sys; print(json.load(sys.stdin)["clientSecret"], end="")' \
     | bunx wrangler secret put GOOGLE_CLIENT_SECRET
   ```

   The same secret is in the Firebase console (Authentication > Sign-in method > Google > Web SDK
   configuration) and in Google Cloud (APIs & Services > Credentials > the web client).
2. Turn on the **Google Calendar API** for the project (APIs & Services > Library).
3. Add the scope `.../auth/calendar.app.created` to the OAuth consent screen (Google Auth
   Platform > Data access > Add or remove scopes). Without it, the consent screen still works for
   test users but shows the scope as unlisted.

Until `GOOGLE_CLIENT_SECRET` is set, the portal shows only the feed.

### The portal

The portal calls this Worker at `VITE_CALENDAR_URL` (production) and `STAGING_VITE_CALENDAR_URL`
(staging), which are repository variables on huishouden/portal.

### Deploy

```sh
bun run deploy:staging      # huishouden-calendar-staging, the huishouden-staging project
bun run deploy              # production
bunx wrangler tail          # one line of counts per run and per request
```

CI deploys staging, then production, on every push to `main` once the organisation secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` reach this repo; until then the deploy job is
skipped with a notice. The Worker's URL is `https://huishouden-calendar.<account>.workers.dev`
(`-staging` for staging). It takes its own origin from each request, so feed links follow the
account's workers.dev subdomain.

## Development

```sh
bun install
bun run lint
bun run test:emulator   # the Firestore emulator with huishouden/rules' rules (a checkout next to this one, or RULES_PATH)
```

The tests use the real household rules in the Firestore emulator. Google (OAuth, Calendar API,
batches) and Firebase Auth are faked. D1 is SQLite and KV is a map. Test data is invented
(`example.com` addresses, a `demo-` project).
