# Ceko realtime slice

A running vertical slice of the realtime layer: Postgres + Redis + **two** API
instances + an end-to-end suite that exercises the failure modes the design
turns on.

Two instances is the point. A single-instance setup cannot exercise the Redis
fan-out, and that is where the interesting bugs live.

## Run it

```bash
./run-e2e.sh
```

Brings up the cluster, waits for both instances, runs the suite, tears down.
Needs Docker and Node 22.

To leave it running and iterate:

```bash
docker compose up -d --build api-1 api-2
npm install && npx tsc -p tsconfig.json
DATABASE_URL=postgres://ceko:ceko@localhost:5432/ceko JWT_SECRET=e2e-secret \
API_1=http://localhost:3001 API_2=http://localhost:3002 \
  node --test dist/test/e2e.test.js dist/test/rest.test.js
```

Accounts are admin-created, not self-registered, so something has to create
the first one:

```bash
DATABASE_URL=postgres://ceko:ceko@localhost:5432/ceko \
  npm run create-admin -- alice
```

Then open `http://localhost:3001/` for a throwaway Ceko test harness (login,
contacts, DMs, notifications) -- not the real client, just enough to click
around in. The real UI is still "designed but not built" per `CLAUDE.md`.
`http://localhost:3001/admin.html` is the account-management page for that
first admin: create users, edit usernames, promote/demote admins,
disable/enable, reset passwords, switch between the Ceko and Taruna account
kinds. `http://localhost:3001/taruna.html` is the separate harness for
Taruna accounts -- same server, deliberately different session behavior
(see "Two account kinds" below).

### Two account kinds

Taruna accounts share a limited pool of devices, so every Taruna login wipes
that account's conversation membership -- and only that -- back to a clean
slate, and issues no refresh token at all, so a page refresh or closed tab
ends the session for good. Contacts are deliberately left alone: a contact
is one row shared by both sides of the relationship, not a per-user record,
so deleting "the Taruna's half" would delete it from the Ceko's own contact
list too. Nothing is ever deleted from `messages` or `conversations`
themselves either, so the other side (always Ceko) keeps its full history;
only the Taruna's own membership in each conversation is removed and,
later, re-added. A message sent to a Taruna who isn't currently a
participant just sits in the conversation normally -- it becomes visible
again once the Taruna recreates the DM (`POST /conversations` re-joins an
existing `dm_key` conversation rather than only creating new ones) and
calls `POST /conversations/:id/request-pending` to release the backlog.
See `src/taruna.ts` and invariants 13-14 in `CLAUDE.md`.

Ceko's persistent session needs the client to actually use the refresh
cookie, not just the server to keep issuing one: `index.html`/`admin.html`
call `POST /auth/refresh` once on page load, before ever showing the login
form, and restore the session silently if it succeeds. `POST /auth/refresh`
returns the same `{ accessToken, user }` shape as login for exactly this.
A Taruna account never has that cookie, so this 401s immediately for them
and falls through to an ordinary login -- the intended behavior, not a
special case.

## What the suite proves

| Test | What breaks without it |
|---|---|
| cross-instance fan-out | a message sent on api-1 never reaches a socket on api-2 |
| nothing lost when a socket dies | messages sent while a client was offline are gone for good |
| resent message does not duplicate | every lost ack becomes a double-posted message |
| concurrent senders stay gapless | two messages share a seq, and cursors stop meaning anything |
| own echo does not duplicate | the sender sees their own message twice |
| offline edit is delivered | a client shows stale text indefinitely after an edit |
| too-far-behind is told to reload | thousands of messages get streamed down a socket |
| disabled account cannot connect | a deactivated user keeps receiving messages |
| session_version invalidates a token | a password change does not end existing sessions |
| non-participant cannot send | anyone with a conversation id can post into it |
| no send commits ahead of an in-flight send | the ordering guarantee the whole design rests on |

The REST suite (`test/rest.test.js`, single instance) additionally proves:
refresh-token rotation and reuse detection, admin-disable drops a live
socket, blocked/unknown tag lookups are indistinguishable, mutual pending
contact requests auto-accept instead of duplicating, DM creation is
idempotent via `dm_key`, the REST fallback send dedupes on
`clientMessageId` exactly like the socket path, read receipts are
monotonic, a message cannot reference an attachment that was never
actually uploaded, a contact's connect/disconnect is pushed live and
reflected on the next REST pull, and presence never reaches a
non-contact's socket.

Presence's production timings (30s heartbeat, 90s online window, 12s
offline debounce) are overridable via `PRESENCE_*` env vars --
`docker-compose.yml` tunes them down for `api-1`/`api-2` so the suite
above runs in seconds instead of minutes without changing what ships.

The suite also proves the two-account-kind design: Taruna login returns no
session cookie and wipes conversation membership while leaving contacts
untouched; Ceko login is unaffected; a Ceko message sent to an offline
Taruna stays hidden through a wipe and a DM re-creation until
`request-pending` explicitly releases it; and an ordinary Ceko-Ceko
conversation is completely unaffected
by the new `pending_release_seq` column (it just stays `NULL`).

### Push notifications

Ceko accounts get real Web Push -- a notification that arrives even with
the tab closed, not just the in-page one that only fires over a live
socket. `public/sw.js` is the service worker; `src/push.ts` wraps
`web-push`; `GET /push/vapid-public-key`, `POST /push/subscribe`, and
`DELETE /push/subscribe` are the REST surface for it. Sending only ever
targets participants with zero connected sockets at that instant --
whoever's live gets the in-page notification off the same event instead,
so nobody gets double-notified. Taruna accounts are refused at
`POST /push/subscribe` (403 `NOT_SUPPORTED`): a subscription is a standing
record tying a device to an account, exactly what a Taruna session is
built never to leave.

Requires `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` (generate
via `node -e "console.log(require('web-push').generateVAPIDKeys())"`).
Unset in local dev, push is just silently disabled -- the server logs one
warning at startup and nothing else changes. `test/rest.test.ts` covers
the subscribe/unsubscribe endpoints against real Postgres; actual delivery
needs a real browser's notification-permission grant and a real push
service (FCM/Mozilla), neither of which `node --test` can exercise.

## Layout

```
migrations/   001 (yours) + 002 realtime + 003 mutation cursor + 004 refresh
              tokens + 005 account kinds
src/
  message-service.ts   the send path, backfill, and participant auth --
                        the only place a message is written or authorised
  message-store.ts     client reconciliation (shared with the browser)
  socket.ts            auth middleware, rooms, message:send, sync, presence, typing
  presence.ts           heartbeat/sweep/online-check
  taruna.ts             the per-login wipe for Taruna accounts
  server.ts            http + socket.io + redis adapter + the Express app
  auth.ts              token signing and the session_version check
  refresh-token.ts     rotation with reuse detection
  tag.ts / password.ts / cookies.ts / rate-limit.ts / storage.ts
  http/                REST routers: auth, admin, social, conversations, uploads
  create-admin.ts      bootstraps the first admin account
public/index.html       Ceko test harness, served at "/"
public/taruna.html       Taruna test harness, served at "/taruna.html"
public/admin.html        account management, including account-kind switch
test/e2e.test.ts        socket suite, two instances
test/rest.test.ts       REST suite, one instance
test/rest-unit.test.ts  no infra needed (password/tag/cookie logic)
```

## Notes

- `transports: ["websocket"]` on both server and client, so no sticky sessions
  are needed at the load balancer.
- The adapter's pub/sub clients are separate connections from the participant
  cache. A Redis client in subscriber mode cannot issue ordinary commands.
- `JWT_SECRET` here is a development default. Replace it before this touches
  anything real.
- Presigned uploads write to local disk (`UPLOAD_DIR`, default `./uploads`)
  behind the same `Storage` interface real S3 would implement -- see
  `src/storage.ts`. That mock is per-instance, not shared, so an upload
  presigned by `api-1` can only be referenced through `api-1`; swapping in
  real object storage removes that constraint along with the rest of the
  mock.
