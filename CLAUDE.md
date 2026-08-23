# Ceko — realtime layer

Discord-style chat app. Admin-created accounts, 6-char lookup tags, DMs and group
chats, voice/video via a managed SFU. This repo is the **realtime slice**: the
message delivery path, proven end to end against Postgres + Redis + two API
instances.

Full design note: https://claude.ai/code/artifact/0231cf3c-50bd-4e0a-b9e9-54e45c0c4a85

## Run it

```bash
./run-e2e.sh          # cluster up, 11 e2e tests, teardown
```

## Invariants — do not break these without reading the design note

These are load-bearing. Each one is enforced by a test that will fail loudly.

1. **`messages.seq` is the ordering key. Never `created_at`.**
   `now()` is transaction-start time, so overlapping sends can commit in the
   opposite order to their timestamps and a timestamp cursor permanently skips
   the loser. Measured: 17 inverted pairs out of 40 concurrent sends.

2. **seq is allocated by `UPDATE conversations SET last_seq = last_seq + 1
   RETURNING last_seq`, inside the same transaction as the INSERT.**
   The row lock is the serialisation point that makes seq order equal commit
   order. Do not replace it with a SELECT-then-UPDATE, a sequence, or a Redis
   counter without understanding what breaks.

3. **Keep the send transaction short.** It holds a lock every other sender in
   that conversation queues behind. No S3, no SFU calls, no fan-out inside it.

4. **Fan out only after COMMIT.** If the process dies in between, the message is
   durable and the next reconnect's sync recovers it. That is why there is no
   outbox table.

5. **Every send re-checks `conversation_participants`.** Never authorise from
   socket room membership — rooms are joined at connect time and go stale.

6. **History queries must return soft-deleted rows as tombstones**, not filter
   them. Filtering punches permanent holes in the client's sequence and it
   chases gaps that can never close.

7. **Backfill needs both cursors:** `seq > $2 OR mutated_at > $3`. Edits and
   deletes deliberately do not advance seq, so the seq cursor alone cannot see
   them and offline clients show stale text forever.

8. **`client_message_id` is unique per conversation.** A `23505` on
   `messages_client_id_key` is the retry path, not an error — re-read the row
   and ack it.

9. **Client: dedupe on `id`, reconcile the optimistic copy on
   `clientMessageId`.** Different questions. The server's broadcast and its ack
   race, and both orders must produce exactly one bubble.

10. **`transports: ["websocket"]` on both ends.** Polling would require sticky
    sessions at the load balancer.

11. **The Redis adapter's pub/sub clients must be separate connections** from
    the participant cache. A subscriber-mode client cannot issue commands.

## Layout

```
migrations/001_schema.sql            original schema
migrations/002_realtime.sql          seq, client_message_id, dm_key, blocks, last_read_seq
migrations/003_message_mutations.sql mutated_at + trigger (the second sync cursor)
migrations/004_rest_surface.sql      refresh_tokens (rotation + reuse detection)
src/message-service.ts               the ONLY place a message is written or authorised
src/message-store.ts                 client reconciliation, shared with the browser
src/socket.ts                        auth middleware, rooms, message:send, sync
src/server.ts                        http + socket.io + redis adapter + the Express app
src/auth.ts                          JWT + session_version revocation check
src/refresh-token.ts                 rotation, with theft-shaped reuse detection
src/tag.ts, password.ts, cookies.ts, rate-limit.ts, storage.ts   REST building blocks
src/http/                            REST routers: auth, admin, social, conversations, uploads
src/create-admin.ts                  bootstraps the first admin account (accounts are admin-created)
public/index.html                    throwaway browser test harness, served at "/" -- not the real UI
public/admin.html                    account management for that harness: create/edit/disable/promote users
test/e2e.test.ts                     11 tests against a live two-instance cluster
test/rest.test.ts                    REST integration tests, one instance
test/rest-unit.test.ts               password/tag/cookie logic, no infra needed
```

## Built vs designed

**Built and tested:** schema, send path, backfill with both cursors, sync,
socket auth with `session_version` revocation, client store (16 unit tests),
cross-instance fan-out, and the REST surface (auth + refresh rotation, admin
user creation, contacts/blocks, idempotent DM creation, presigned uploads
against a local-disk mock).

**Designed but not built:** presence (Redis ZSET + heartbeat + sweeper,
narrow fan-out to contacts only), typing beyond the raw relay, calls (LiveKit
token vending, ring-timeout reconciliation), real object storage in place of
the local-disk upload mock, and all UI. The design note covers each.

## Testing discipline used here

Tests that pass first try are suspect. Both suites were validated by
deliberately breaking the code and confirming the tests noticed — 9 mutants on
the client store, 5 sabotages on the server. When running a sabotage matrix,
verify a clean baseline **before and after**; a broken baseline once made an
entire matrix meaningless here.

## Not proven yet

The `created_at` flaw is not caught by the e2e suite (its sends commit one at a
time) — that proof is in `test_ordering.py`. No load testing; the ~135 msg/sec
per conversation figure is from a small container. Two instances proves fan-out
crosses a process boundary, nothing about ten.
