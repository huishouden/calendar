# calendar

The household in each person's own calendar. A Cloudflare Worker on the free plan offers two ways
in, and every person sets theirs up in the portal (Settings > Calendar):

- **A calendar feed**: a secret URL (`webcal://` or https) that Apple Calendar, Google Calendar,
  Outlook and any other calendar app subscribes to. It is read-only and refreshes as often as the
  calendar app checks.
- **Google Calendar sync**: a "Huishouden" calendar in the person's Google account, in the suite's
  green, kept in step every 5 minutes, both ways. Moving, renaming or deleting an event there changes
  the record in the app. Each change shows in the portal's history with Undo.

It also checks **Spending's alert inboxes**: Gmail accounts a member connected in Spending
(Settings > Email) so the household's card-alert emails become transactions within about 5
minutes, with no app open ("Spending's alert inboxes" below).

What a person sees is what they may see in the household, in their language, with their settings.
Helpers and kids get nothing private and no bills. Health items go only to the person, their carers
and the admins, and by default read "Medicine for Ana" or "Appointment for Ana" with no detail, because calendars are often
shared. With Health details turned on in the person's calendar settings, an appointment's description
carries its kind, doctor, place and what to bring; its notes never leave the app.

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

Times are on the household's clock: the home's time zone (`households/{id}.home.timeZone`, read
with the household on every check), else the zone the person's device had when they set the
calendar up. Things that happen at home (the Home app's events) carry the home's address as their
location (`LOCATION` in the feed, `location` in Google).

| File | Does |
|---|---|
| `src/index.ts` | Routes: `/feed/<secret>.ics`, `/api/*`, the cron (every minute), the queue, and `Fanout` (the entrypoint the Worker calls itself through) |
| `src/feed.ts` | The feed: the precomputed calendar from D1, `ETag`/304. Never builds one |
| `src/api.ts` | The portal's calls: status, set up / rotate / revoke the feed, connect / sync / disconnect Google |
| `src/tick.ts` | The cron: who is due this minute, checked a few at a time in their own invocations |
| `src/check.ts` | The cheap check for a few people: did anything they see change? Marks and queues the work |
| `src/work.ts` | One unit of a person's work per invocation: build their feed, or one round of their sync. Lease, back-off |
| `src/person.ts` | Acting as the person: their ID token on every Firestore call, their role and settings, the change signal |
| `src/sync.ts` | One round of a person's Google sync: Google's changes, the household's, the writes in a batch |
| `src/warm.ts` | Run at startup: a small export, so a build in a fresh isolate doesn't pay for first use |
| `src/backsync.ts` | A change made in Google read as an edit and applied to the record as the person |
| `src/google/*` | OAuth (code exchange, refresh, revoke), the Calendar API with batching, event bodies and ids |
| `src/store.ts`, `src/seal.ts` | Sealed records and feeds in D1, feed secrets' owners in KV, sync state in D1 |

### Signing in as the person

The portal posts the signed-in person's Firebase refresh token to the Worker, with their Firebase
ID token, over CORS from the suite's own site only. The Worker checks that the refresh token is the
caller's own (Firebase Auth's token service says whose it is). After that, the Worker exchanges the
refresh token for ID tokens on each run (`@huishouden/pwa-kit/firebase-auth-rest`) and calls
Firestore over REST with them (`/firestore-rest`). This is the same way huishouden/connector acts.

### What is kept, and where

Records are sealed with AES-256-GCM, the key derived with HKDF from the `SEAL_KEY` secret and the
record's purpose.

- **D1** holds, keyed by `pid` (a hash of household and email):
  - the person's sealed record: their refresh token, feed secret, Google refresh token and calendar
    id, language and time zone (KV held it before; a record still there moves to D1 when first read);
  - their **precomputed feed**, keyed by a hash of the feed secret and sealed with a key that also
    needs the secret from the URL, so the Worker's key alone can't open it;
  - the sync state: which Google event stands for which agenda key, the hash and a snapshot of what
    was written, the etag our own write got back, Google's sync token;
  - the work a check found, the lease of the unit working on it, and Google's back-off.
- **KV** holds, per feed secret, whose it is, sealed the same way as the feed. KV keys are hashes.

Nothing in D1 or KV is readable without the secrets.
- **Firestore** holds what the person chose (`calendarSettings/{email}`) and the history of changes
  from Google (`calendarChanges`), both readable only by that person. Tokens never go there.

### The feed

`GET /feed/<secret>.ics` (also `HEAD`) serves the feed stored for that URL, with its `ETag`, or a
304 to a client that sent it. It costs a hash, one D1 read and an AES-GCM open. **A request never
builds a feed** and never asks Firestore. The feed is built ahead of time, as the person, whenever
what they see changes (see "Many households" below):

- **set up or rotated** in the portal: built before the portal shows the link, in its own
  invocation (rotating seals the same calendar again for the new URL);
- **something they see changed** (an item, their role, their settings): the next check notices
  through the **change signal**, and the work builds it within seconds. The signal is a count and a
  sum of `updatedAt` for the agenda, personal agenda, to-dos and personal to-dos, one aggregation
  each, plus the person's role and settings;
- **each request** for a feed-only person asks for a check of them (its own invocation, after the
  answer, at most every 5 seconds), so a change made in the portal reaches the calendar app at its
  next fetch;
- **older than a day**: the request marks it stale, and the next check builds it again anyway.

A feed with nothing stored yet (made before this design, or its build failed) is built in its own
invocation while the request waits. If that fails too, the answer is 503 with `Retry-After: 60`.

The feed asks to be refreshed hourly (`REFRESH-INTERVAL`, `X-PUBLISHED-TTL`: PT1H). If the
household can't be reached, the stored feed stays rather than an empty calendar. Someone who left
the household gets a 404, and their feed is deleted.

### Google Calendar sync, both ways

A check every 5 minutes (below) asks Google's change list and the change signal. When either moved,
a round of the sync runs for the person:

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
4. **The difference goes to Google**, up to 50 writes in a batch request per round. More than that
   (a first sync) goes in the next round, at once:
   - new events are inserted with ids made from the person and the key, so a retry can't make
     two;
   - changed events are rewritten (whole, recurrence included);
   - moved occurrences are patched as instances;
   - events no longer in the agenda are deleted.

   Each event carries the private property `huishouden` (`'<household>:<key>'`). The kit's calendar
   import skips such events, so nothing exported comes back as a suggestion.

A full rebuild happens at least every 6 hours anyway. Each round logs one line of counts. Logs never
hold titles, emails, households or tokens.

## Many households

Everything runs on Cloudflare's free plan, for any number of households up to about 1,000 people.
The limits that shape it:

| Free plan | Limit |
|---|---|
| CPU per invocation (request, cron, queue message) | 10 ms |
| Subrequests per invocation | 50 (1,000 to Cloudflare services) |
| Invocations a request may start through service bindings | 32 |
| Workers requests | 100,000 a day |
| Queues | 10,000 operations a day (3 per message: write, read, delete) |
| KV | 100,000 reads, 1,000 writes a day |
| D1 | 5 million rows read, 100,000 rows written a day; 5 GB |
| Cron Triggers | 5 per account (this Worker uses one per environment) |

### How the work is split

1. **The cron, every minute** (`src/tick.ts`). Each person has a fixed slot (a number 0..59 from
   their `pid`). People with Google are checked every 5 minutes, people with only a feed every 15
   (calendar apps fetch hourly at most). The people due this minute go out in chunks of 8, a
   household's members together, each chunk to **its own invocation** of this Worker:
   `env.SELF.check(pids)`, a service binding to the Worker's own `Fanout` entrypoint. Each
   invocation has its own 10 ms and 50 subrequests. The cron starts at most 30 (Cloudflare allows
   32 per request).
2. **The check** (`src/check.ts`), per person: Google's change list with the sync token (our own
   writes coming back move the token on, nothing more), then the change signal. The household and
   the person's settings come in one `batchGet`. The household's shared lists are read once for all
   its members in the chunk: the count and sum are the same query whoever asks, and only go into
   each member's own signal. **When nothing changed, nothing is written**: no D1 row, no queue
   message. A chunk stops before its 50 subrequests, and the cron gives the rest to another
   invocation.
3. **The work** (`src/work.ts`): a check that finds a change marks it in D1 and sends **one queue
   message for the person** (never a second while one is on its way). The consumer takes one
   message per invocation (`max_batch_size = 1`). It does **one unit**: one round of the sync (up to
   50 writes), or building the feed. The next unit, the other kind or more writes, is its own
   invocation (`env.SELF.work`), straight away.
   - **Per-person order**: a unit holds the person's lease in D1. A second unit for them waits
     (the message comes back in 30 seconds), and the checks skip them meanwhile. Units work from what
     Firestore and Google say at the time, so their order can't undo anything.
   - **Back-off**: Google's 429, or a 403 whose reason is a rate limit (`rateLimitExceeded`,
     `userRateLimitExceeded`, `quotaExceeded`), backs the person off, from 30 seconds doubling to an
     hour. Nothing is asked of Google for them until then, and the message comes back after it. A 403
     for access is an error, not a back-off.
   - **When the queue says no** (its 10,000 daily operations used up): the work stays marked, and
     the cron runs it from its spare invocations. A message lost after 3 retries goes the same way
     after 10 minutes.
4. **Firestore's own quota**: a project on the free (Spark) plan has 50,000 reads a day for
   everything, the apps included. Once they are used up, every read fails until midnight Pacific
   time: the apps' too. `FIRESTORE_CHECK_READS` (`wrangler.toml`) is the share the checks may use,
   at about 5 reads a check. Once an hour, the cron works out how often it can check everyone within
   it (every 5, 10, 15, 20, 30 or 60 minutes) and checks less often rather than go over it. When
   Firestore answers 429 anyway, the checks stop for 15 minutes.

### What 1,000 people cost a day

The worst case: 1,000 people, each with Google sync and a subscribed feed that their calendar app
fetches hourly, and 3 changes a day that each of them sees (changes within a 5-minute check count
once).

| Resource | Arithmetic | A day | Free plan |
|---|---|---|---|
| Workers requests | cron 1,440 + checks 1,000 × 288 ÷ 8 = 36,000 + feed fetches 1,000 × 24 = 24,000 + sync units 3,000 + feed units 3,000 + portal ~500 | **~68,000** | 100,000 |
| (all feed-only instead) | cron 1,440 + checks 1,000 × 96 ÷ 8 = 12,000 + fetches 24,000 + checks asked by fetches 24,000 + feed units 3,000 + portal ~500 | ~65,000 | 100,000 |
| Invocations per cron run | 1,000 × 12 slots ÷ 60 minutes = 200 people a minute ÷ 8 | 25 | 32 |
| Subrequests per check invocation | 8 people × ~5 (change list, `batchGet`, 2 aggregations, a token now and then) + the household's 2 shared aggregations | ~45 | 50 |
| Queue operations | 3,000 messages × 3 | **9,000** | 10,000 (more runs from the cron) |
| D1 rows written | per change ~15 (mark, lease, person, ~2 events, release, feed; indexes included) × 3,000 = 45,000 + token after echoes 3,000 + ticks 1,440 + stale feeds 5,000 | **~55,000** | 100,000 |
| D1 rows read | cron 200 a minute × 1,440 = 288,000 + checks 288,000 + feed rows 288,000 + events read on echoes ~150,000 + syncs ~160,000 + fetches 24,000 | ~1.2 million | 5 million |
| D1 storage | feeds ~40 KB sealed + ~50 events × ~1 KB, per person | ~90 MB | 5 GB |
| KV | reads: none on the request path (only a feed with nothing stored); writes: one per feed set up or rotated | ~0 / ~10 | 100,000 / 1,000 |

**Why the feeds are in D1, not KV:** 3,000 rebuilds a day (and 6,000 at 6 changes a day) would be
3 to 6 times KV's 1,000 writes a day, while D1 allows 100,000 rows written. The Cache API is per
data centre and can be evicted at any time, so a feed there would still need rebuilding in requests.

**Firestore is the limit that bites first.** The checks cost about 5 reads each: 1,000 people every 5
minutes is ~1.4 million reads a day, against 50,000 a day on the free Spark plan for everything. With
`FIRESTORE_CHECK_READS = 20000` (40% of it), Spark keeps 5-minute checks for about 13 people with
Google (20,000 ÷ (288 × 5)) or 40 with only a feed. Past that, the checks space out on their own,
down to hourly. 1,000 people within 5 minutes of a change needs the project on Blaze: ~1.4 million
reads a day is $0.40 to $0.80 a day after the free 50,000 ($0.03 to $0.06 per 100,000 reads,
by the database's location). Then raise or unset
`FIRESTORE_CHECK_READS`.

## Spending's alert inboxes

Card alerts often arrive at a different Gmail address from the one a member signs in to Huishouden
with. In Spending, Settings > Email > Connect alert inbox opens Google's account chooser
(`googleAuthCode(…, { selectAccount: true })` in the kit), and the member picks the Gmail account
the alerts go to and allows read-only access (`gmail.readonly`). Any admin or member may connect
one, and a household may have several (two partners' cards). Helpers and kids never see Spending.

| File | Does |
|---|---|
| `src/mail/api.ts` | Spending's calls: status, connect, check now, disconnect, the review list and its answers, undo last import |
| `src/mail/check.ts` | The checks: every 5 minutes per inbox, fanned out after the calendar's (`SELF.mail`) |
| `src/mail/work.ts` | One unit of an inbox's import (queue message `{ inbox }`): search, read, parse, write |
| `src/mail/recheck.ts` | Reading alerts (the kit's `readAlert`), and re-reading past imports when `PARSER_VERSION` goes up |
| `src/mail/shape.ts` | The masked shape of each email read (`mail_shapes`), for supporting new alert formats |
| `src/mail/gmail.ts` | Gmail's `profile`, `history.list`, `messages.list`, `messages.get` |
| `src/mail/inbox.ts`, `src/mail/store.ts` | The household side as the member (cards, rules, the inbox's document); sealed records in D1 |

### How a check works

1. **Gmail's history.** `users.history.list` from the history id the last check ended at
   (`historyTypes=messageAdded`): did any mail arrive? Usually not, and the check ends after one
   request, with no Firestore read and no write.
2. **The household's search.** When mail arrived, `users.messages.list` with the household's search
   (the kit's `alertQuery`: each card's alert words, the alert labels) and `after:` the inbox's
   `since` less a day. Messages already read are in D1's seen list. None new: done.
3. **The import**, a queued unit of its own (3 messages per unit, so each fits the free plan's 10 ms
   of CPU; a unit that leaves some hands the rest to the next). It reads the messages, parses them
   with the kit's `@huishouden/pwa-kit/spending-core`, the very code Spending runs, in the
   household's time zone, matches them against the household's transactions from four days before
   the oldest (`planAlerts`: statements and other members' alerts are not added twice), and writes
   the new ones as `spendingTransactions` (`source: 'alert'`) **as the member who connected the
   inbox**, so the household's rules apply. The inbox's document gets `lastAlertAt` and `lastAdded`.

**Only what it reads with confidence is written.** The kit's `readAlert` makes a transaction only
when a purchase rule (an issuer's wording such as Visa Purchase Alerts or "You made a $X
transaction with M", or a generic "purchase/transaction/charge of $X at M") finds both the amount
and a merchant it can trust; never "Card Purchase", never prose ("at a reasonable price"), and the
amount is the rule's, not the first one in the email. Payments, declined charges, statements,
security notices and mail sent to a list without purchase wording (offers, an investing account's
notices) are left alone. Emails that look like purchases but can't be read go to a **review list**:
Spending shows "Last import: N added, M need review", and the member who connected the inbox sees
each email's subject and date and answers Not a purchase or enters it. The date is the
transaction's own when the email writes one (at most 10 days before it), else the day it was sent
in the household's time zone.

**Each import has an id** (`importId` on the transactions it wrote): **Undo last import** (the
member who connected the inbox, or an admin) deletes them as the caller, and their emails are never
written again.

**Re-reading past imports.** `PARSER_VERSION` (src/mail/recheck.ts) goes up whenever the way alerts
are read changes. An inbox read with an older one is re-read, 3 emails a unit, once nothing new is
waiting: by each email's Gmail id in the seen list, as the member, a transaction the checker wrote
(`al-<id>`, by that member, after connecting) is corrected when the email now reads as a purchase,
deleted when it is not one (or can't be read: then it goes to the review list), and a purchase it
missed is written. Answered emails, transactions someone deleted, statement rows and alerts the
app's own Check email wrote are left alone.

The household's cards, labels and category rules are read as the member when an inbox is
connected, on Check now, and at most every 12 hours, and kept sealed with the inbox. So a check
needs no Firestore read, and an import reads only the recent transactions.

**The first check** searches back to two days before the household's newest transaction, at most
30 days: alerts missed while nothing was checking are added, and older ones (likely in a statement
already) are not. When Gmail no longer has the history id (about a week without a check), the
search covers the gap.

**Errors.** Access removed in Google (`invalid_grant`): the inbox is marked `revoked`, its document
says so, Spending shows Reconnect, and its checks stop until it is connected again. The member left
the household or lost the role: `not-member`, checks stop. No alert words or labels:
`nothing-to-search`. Gmail's rate limit backs the inbox off (30 s, doubling to an hour).

**Disconnect** (the member who connected it, or an admin) deletes the inbox's document, revokes
Google's grant (`oauth2.googleapis.com/revoke`), and deletes everything the Worker kept for it. The
transactions it added stay: they are the household's.

### Privacy

- `gmail.readonly` is a **restricted** scope. Until Google verifies the app (a security assessment),
  Google shows its "Google hasn't verified this app" warning in the window, and at most 100 Google
  accounts can grant it. The Worker uses the grant only to search the household's alert words and
  labels and to read the messages that match.
- What is kept from an email is what Spending writes for it: date, merchant, amount, category, card
  (last four digits), and the Gmail message id; the review list and shapes below. Nothing else of an email is stored, and nothing of
  one is logged. The logs hold counts (`found`, `read`, `added`, `duplicates`), never an address,
  sender, subject or merchant; the Worker sends nothing to New Relic.
- To support alert formats it can't read yet, D1 keeps each email's **shape** for 14 days
  (`mail_shapes`): the sender's domain (its address only when that is a role such as `alerts@`), and
  the subject and the lines with an amount or purchase wording with every word outside a fixed
  alert vocabulary, every all-capitals word, every number and amount masked ("You made a $#
  transaction with X on your card ending in #"), and what the parser made of it. No merchant, name,
  amount or address survives. The subjects on the review list are sealed (`review:<inbox>`) and
  shown only to the member who connected the inbox.
- D1 holds each inbox under a hash; who connected it, its address, Google's refresh token, the
  member's Firebase sign-in and the household's search terms are sealed (AES-GCM, `SEAL_KEY`).
  Firestore holds only the address, who connected it and what the checker last found
  (`spendingInboxes`, huishouden/rules).

### What it costs

Per inbox, every 5 minutes: one Google token (cached per isolate) and one history request. With
mail, one search. With new alerts, one queued unit per 3 messages: about 6 requests, one Firestore
query (the recent transactions), one commit. D1 is written only when something changed, or every 30
minutes to move the history id; "Updated ... ago" comes from one row per minute of checks
(`mail_ticks`). At 100 inboxes: about 29,000 checks a day in about 4,800 invocations, roughly
10,000 D1 rows written, and Firestore reads only for imports (a handful per alert). Google's own
limit is the binding one: 100 accounts while the app is unverified.

## Limits

- **Subscribed feeds refresh slowly in Google Calendar.** Google re-reads a subscribed URL on its
  own schedule, typically every 8 to 24 hours, and ignores `REFRESH-INTERVAL`. Apple Calendar
  follows the hourly hint (or its own setting); Outlook refreshes on its own schedule, every few hours. For Google, use
  the sync, which shows changes within about 5 minutes.
- **A change reaches Google within 5 minutes**, plus a few seconds for the work: the check that
  notices it runs every 5 minutes (longer only when Firestore's read budget asks, see "Many
  households"), and the work runs within seconds of it.
- **Firestore's free tier**: a check costs about 5 reads. A feed build or a sync round reads the
  person's agenda, a few hundred documents. When the project's daily quota is used up (Spark: 50,000
  reads), Firestore answers 429 until midnight Pacific time: the portal's calls get 503
  `firestore-quota` (the portal says so, rather than "couldn't reach"), feeds serve what is stored,
  and the checks pause.
- **CPU**: every invocation stays within the free plan's 10 ms. A request serves what is stored. A
  check is a few small reads per person. A build or a sync round is one person's calendar in its own
  invocation, and the cold start (language catalogues, the runtime's time zone data, compiling the
  export) happens once per isolate at startup (`src/warm.ts`), which Cloudflare limits separately.
  Measured on staging: see "CPU, measured" below.
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

### CPU, measured

Staging, `wrangler tail` (each invocation's `cpuTime`): to follow, once staging's Firestore quota is
back.

## One-time setup

All of it is done once for the whole suite, never per household.

```sh
bun install
# Storage (the ids are in wrangler.toml).
bunx wrangler d1 create huishouden-calendar
bunx wrangler kv namespace create huishouden-calendar
bunx wrangler queues create huishouden-calendar-work            # and huishouden-calendar-work-staging
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
4. "Continue in this tab" (when the browser blocks Google's window, or it opens out of sight): the
   pages Google sends the code back to are Authorized redirect URIs of the web client (APIs &
   Services > Credentials) and are listed in `GOOGLE_REDIRECT_URIS` in `wrangler.toml`, exactly:
   `https://<site>/my-calendar` and `https://<site>/spending/`. The app sends that page as
   `redirectUri` with the code, and the Worker exchanges it with that `redirect_uri`; without one it
   is the popup's `postmessage`. Any other page is refused (400 `redirect-uri`).

Until `GOOGLE_CLIENT_SECRET` is set, the portal shows only the feed.

### Spending's alert inboxes

The same web client and secret. The **Gmail API** must be on in the project (it is in both
huishouden-piekstra and huishouden-staging, because Spending's in-app check uses it too). Adding
`.../auth/gmail.readonly` to the consent screen's scopes lists it there; it is a restricted scope,
so Google keeps showing its unverified-app warning until the app passes verification.

Spending calls this Worker at `VITE_CALENDAR_URL` and `STAGING_VITE_CALENDAR_URL`, repository
variables on huishouden/spending as on the portal.

### The portal

The portal calls this Worker at `VITE_CALENDAR_URL` (production) and `STAGING_VITE_CALENDAR_URL`
(staging), which are repository variables on huishouden/portal.

### Deploy

```sh
bun run deploy:staging      # huishouden-calendar-staging, the huishouden-staging project
bun run deploy              # production
bunx wrangler tail          # one line per request, check run, unit of work and tick, with each invocation's cpuTime
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

## License

Source available under [PolyForm Shield 1.0.0](LICENSE): you may use, study and modify this code
for any purpose except providing a product that competes with Huishouden.

Huishouden and its logo are the project's brand; please don't use them for other products.
