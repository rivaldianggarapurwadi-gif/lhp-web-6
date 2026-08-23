import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { io as connect, Socket } from "socket.io-client";
import { Pool } from "pg";
import { signAccessToken } from "../src/auth.js";
import { generateTag as tag } from "../src/tag.js";
import { MessageStore } from "../src/message-store.js";
import type { ServerMessage } from "../src/message-store.js";

const A_URL = process.env.API_1 ?? "http://localhost:3001";
const B_URL = process.env.API_2 ?? "http://localhost:3002";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://ceko:ceko@localhost:5432/ceko",
});

interface Ctx { alice: string; bob: string; conv: string; }

async function makeFixture(): Promise<Ctx> {
  const alice = randomUUID();
  const bob = randomUUID();
  const conv = randomUUID();
  await pool.query(
    `INSERT INTO users (id, username, tag, password_hash) VALUES ($1,'alice',$2,'x'), ($3,'bob',$4,'x')`,
    [alice, tag(), bob, tag()]
  );
  await pool.query(
    `INSERT INTO conversations (id, type, name, created_by) VALUES ($1,'group','fixture',$2)`,
    [conv, alice]
  );
  await pool.query(
    `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1,$2), ($1,$3)`,
    [conv, alice, bob]
  );
  return { alice, bob, conv };
}

function open(url: string, userId: string): Promise<Socket> {
  const socket = connect(url, {
    transports: ["websocket"],
    auth: { token: signAccessToken(userId, 1) },
    reconnection: false,
    forceNew: true,
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`connect timeout ${url}`)), 5000);
    socket.on("ready", () => { clearTimeout(t); resolve(socket); });
    socket.on("connect_error", (e) => { clearTimeout(t); reject(e); });
  });
}

function emit<T = any>(socket: Socket, event: string, payload: any): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`ack timeout: ${event}`)), 5000);
    socket.emit(event, payload, (res: any) => {
      clearTimeout(t);
      if (res?.ok) resolve(res.data);
      else reject(Object.assign(new Error(res?.error?.message ?? "no ack"), { code: res?.error?.code }));
    });
  });
}

function collect(socket: Socket, event: string, n: number, ms = 5000): Promise<any[]> {
  const got: any[] = [];
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`only ${got.length}/${n} ${event} events`)), ms);
    const on = (p: any) => {
      got.push(p);
      if (got.length === n) { clearTimeout(t); socket.off(event, on); resolve(got); }
    };
    socket.on(event, on);
  });
}

const send = (s: Socket, conv: string, content: string, cmid = randomUUID()) =>
  emit(s, "message:send", { conversationId: conv, clientMessageId: cmid, type: "text", content });

let ctx: Ctx;
const sockets: Socket[] = [];
const track = (s: Socket) => { sockets.push(s); return s; };

before(async () => { ctx = await makeFixture(); });
after(async () => {
  for (const s of sockets) s.disconnect();
  await pool.end();
});

// ---------------------------------------------------------------------------

test("a message sent on instance 1 reaches a socket held by instance 2", async () => {
  const a = track(await open(A_URL, ctx.alice));
  const b = track(await open(B_URL, ctx.bob));

  const inbound = collect(b, "message:new", 1);
  const acked = await send(a, ctx.conv, "across the cluster");
  const [received] = await inbound;

  assert.equal(received.id, acked.id);
  assert.equal(received.content, "across the cluster");
  assert.equal(received.seq, acked.seq, "same seq on both sides");
  a.disconnect(); b.disconnect();
});

test("nothing is lost when a socket dies mid-conversation", async () => {
  const fx = await makeFixture();
  const a = track(await open(A_URL, fx.alice));
  let b = track(await open(B_URL, fx.bob));

  const first = collect(b, "message:new", 1);
  await send(a, fx.conv, "seen while connected");
  const [seen] = await first;
  const cursor = seen.seq;

  // Bob's connection drops. Alice keeps talking.
  b.disconnect();
  await new Promise((r) => setTimeout(r, 120));
  for (let i = 1; i <= 5; i++) await send(a, fx.conv, `missed ${i}`);

  // Bob comes back on the OTHER instance and syncs from his cursor.
  b = track(await open(A_URL, fx.bob));
  const res = await emit(b, "sync", { cursors: { [fx.conv]: cursor }, mutatedSince: null });
  const conv = res.conversations.find((c: any) => c.id === fx.conv);

  assert.equal(conv.truncated, false);
  assert.deepEqual(
    conv.messages.map((m: ServerMessage) => m.content),
    ["missed 1", "missed 2", "missed 3", "missed 4", "missed 5"],
    "every message sent while offline, in order, exactly once"
  );
  assert.deepEqual(
    conv.messages.map((m: ServerMessage) => m.seq),
    [cursor + 1, cursor + 2, cursor + 3, cursor + 4, cursor + 5],
    "gapless"
  );
  a.disconnect(); b.disconnect();
});

test("a resent message whose ack was lost does not duplicate", async () => {
  const fx = await makeFixture();
  const a = track(await open(A_URL, fx.alice));

  const cmid = randomUUID();
  const first = await send(a, fx.conv, "did this land?", cmid);
  // Ack never reached the client, so the outbox retries the same id.
  const second = await send(a, fx.conv, "did this land?", cmid);

  assert.equal(second.id, first.id, "same row returned");
  assert.equal(second.seq, first.seq);
  assert.equal(second.deduplicated, true);

  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND client_message_id=$2`,
    [fx.conv, cmid]
  );
  assert.equal(rows[0].n, 1, "one row in the database");

  const { rows: seqs } = await pool.query(
    `SELECT last_seq FROM conversations WHERE id=$1`, [fx.conv]);
  assert.equal(seqs[0].last_seq, first.seq, "the rolled-back retry consumed no seq");
  a.disconnect();
});

test("concurrent senders across both instances produce a gapless sequence", async () => {
  const fx = await makeFixture();
  const a = track(await open(A_URL, fx.alice));
  const b = track(await open(B_URL, fx.bob));

  const N = 30;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      send(i % 2 === 0 ? a : b, fx.conv, `concurrent ${i}`)
    )
  );

  const seqs = results.map((r: any) => r.seq).sort((x, y) => x - y);
  assert.deepEqual(seqs, Array.from({ length: N }, (_, i) => i + 1), "1..N with no gaps");

  const { rows } = await pool.query(
    `SELECT count(*)::int AS n, count(DISTINCT seq)::int AS d
       FROM messages WHERE conversation_id=$1`, [fx.conv]);
  assert.equal(rows[0].n, N);
  assert.equal(rows[0].d, N, "no two messages share a seq");
  a.disconnect(); b.disconnect();
});

test("the sender's own echo does not duplicate in the store", async () => {
  const fx = await makeFixture();
  const a = track(await open(A_URL, fx.alice));

  // Drive the real client store with real socket traffic.
  const store = new MessageStore();
  a.on("message:new", (m: ServerMessage) => store.receive(m));

  const cmid = randomUUID();
  store.enqueue({
    clientMessageId: cmid, conversationId: fx.conv,
    senderId: fx.alice, content: "echo test",
  });
  store.drainEffects();

  const echo = collect(a, "message:new", 1);
  const acked = await send(a, fx.conv, "echo test", cmid);
  store.receive(acked as any);
  await echo;
  await new Promise((r) => setTimeout(r, 150)); // let any stragglers land

  const timeline = store.timeline(fx.conv);
  assert.equal(timeline.length, 1, "one bubble, not two");
  assert.equal(timeline[0].kind, "sent");
  assert.equal(store.outbox(fx.conv).length, 0, "optimistic copy retired");
  a.disconnect();
});

test("an edit made while offline is delivered by the mutation cursor", async () => {
  const fx = await makeFixture();
  const a = track(await open(A_URL, fx.alice));

  const m1 = await send(a, fx.conv, "original text");
  const m2 = await send(a, fx.conv, "second message");

  // Client syncs here and goes offline.
  const syncPoint = await emit(a, "sync", {
    cursors: { [fx.conv]: m2.seq }, mutatedSince: null,
  });

  await new Promise((r) => setTimeout(r, 50));
  await pool.query(
    `UPDATE messages SET content='EDITED while they were away', edited_at=now() WHERE id=$1`,
    [m1.id]
  );

  const res = await emit(a, "sync", {
    cursors: { [fx.conv]: m2.seq },
    mutatedSince: syncPoint.syncedAt,
  });
  const conv = res.conversations.find((c: any) => c.id === fx.conv);
  const edited = conv.messages.find((m: ServerMessage) => m.id === m1.id);

  assert.ok(edited, "seq cursor alone would have missed this entirely");
  assert.equal(edited.content, "EDITED while they were away");
  a.disconnect();
});

test("a client too far behind is told to reload rather than streamed", async () => {
  const fx = await makeFixture();
  const a = track(await open(A_URL, fx.alice));

  await pool.query(
    `INSERT INTO messages (conversation_id, sender_id, content, seq)
     SELECT $1, $2, 'bulk '||n, n FROM generate_series(1, 260) n`,
    [fx.conv, fx.alice]
  );
  await pool.query(`UPDATE conversations SET last_seq = 260 WHERE id = $1`, [fx.conv]);

  const res = await emit(a, "sync", { cursors: { [fx.conv]: 1 }, mutatedSince: null });
  const conv = res.conversations.find((c: any) => c.id === fx.conv);

  assert.equal(conv.truncated, true);
  assert.equal(conv.messages.length, 0, "no point streaming 259 messages down a socket");
  a.disconnect();
});

test("a disabled account cannot open a socket", async () => {
  const fx = await makeFixture();
  await pool.query(`UPDATE users SET disabled_at = now() WHERE id = $1`, [fx.bob]);
  await assert.rejects(() => open(B_URL, fx.bob), /UNAUTHORIZED/);
});

test("bumping session_version invalidates an already-issued token", async () => {
  const fx = await makeFixture();
  const stale = signAccessToken(fx.alice, 1);
  await pool.query(`UPDATE users SET session_version = 2 WHERE id = $1`, [fx.alice]);

  const socket = connect(A_URL, {
    transports: ["websocket"], auth: { token: stale },
    reconnection: false, forceNew: true,
  });
  track(socket);
  await assert.rejects(
    () =>
      new Promise((resolve, reject) => {
        socket.on("ready", resolve);
        socket.on("connect_error", reject);
        setTimeout(() => reject(new Error("timeout")), 4000);
      }),
    /UNAUTHORIZED/
  );
});

test("a non-participant cannot send into a conversation", async () => {
  const fx = await makeFixture();
  const other = await makeFixture(); // unrelated conversation
  const a = track(await open(A_URL, fx.alice));

  await assert.rejects(
    () => send(a, other.conv, "should not land"),
    (e: any) => e.code === "NOT_A_PARTICIPANT"
  );
  a.disconnect();
});

test("a send cannot commit ahead of an in-flight send in the same conversation", async () => {
  const fx = await makeFixture();
  const a = track(await open(A_URL, fx.alice));
  const b = track(await open(B_URL, fx.bob));

  const base = await send(a, fx.conv, "baseline");

  // Hold a message open mid-transaction, exactly as a slow send would.
  const held = await pool.connect();
  await held.query("BEGIN");
  const { rows: seqRow } = await held.query(
    `UPDATE conversations SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq`,
    [fx.conv]
  );
  const heldSeq = Number(seqRow[0].last_seq);
  await held.query(
    `INSERT INTO messages (conversation_id, sender_id, content, seq)
     VALUES ($1, $2, 'FIRST (held open)', $3)`,
    [fx.conv, fx.alice, heldSeq]
  );

  // Bob sends while that transaction is still open. It must queue behind it.
  let settled = false;
  const racer = send(b, fx.conv, "SECOND (racing)").then((r) => { settled = true; return r; });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(settled, false, "the second send is blocked on the row lock");

  // A client syncing right now must not see a hole it could skip past.
  const mid = await emit(a, "sync", { cursors: { [fx.conv]: base.seq }, mutatedSince: null });
  const midConv = mid.conversations.find((c: any) => c.id === fx.conv);
  assert.deepEqual(midConv.messages, [], "neither message is visible yet");

  await held.query("COMMIT");
  held.release();
  const second = await racer;

  assert.equal(second.seq, heldSeq + 1, "the racer got the next seq, not an earlier one");

  const res = await emit(a, "sync", { cursors: { [fx.conv]: base.seq }, mutatedSince: null });
  const conv = res.conversations.find((c: any) => c.id === fx.conv);
  assert.deepEqual(
    conv.messages.map((m: ServerMessage) => m.content),
    ["FIRST (held open)", "SECOND (racing)"],
    "both delivered, in commit order, with no chance to skip the first"
  );
  a.disconnect(); b.disconnect();
});
