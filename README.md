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
monotonic, and a message cannot reference an attachment that was never
actually uploaded.

## Layout

```
migrations/   001 (yours) + 002 realtime + 003 mutation cursor + 004 refresh tokens
src/
  message-service.ts   the send path, backfill, and participant auth --
                        the only place a message is written or authorised
  message-store.ts     client reconciliation (shared with the browser)
  socket.ts            auth middleware, rooms, message:send, sync
  server.ts            http + socket.io + redis adapter + the Express app
  auth.ts              token signing and the session_version check
  refresh-token.ts     rotation with reuse detection
  tag.ts / password.ts / cookies.ts / rate-limit.ts / storage.ts
  http/                REST routers: auth, admin, social, conversations, uploads
  create-admin.ts      bootstraps the first admin account
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
