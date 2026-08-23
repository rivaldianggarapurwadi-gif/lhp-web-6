import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { io as connect, Socket } from "socket.io-client";
import { signAccessToken } from "../src/auth.js";
import { hashPassword } from "../src/password.js";
import { generateTag } from "../src/tag.js";

// REST doesn't need the two-instance cross-fan-out setup e2e.test.ts proves --
// api-1 alone is enough here. It shares the cluster run-e2e.sh already
// brought up for the socket suite.
const A_URL = process.env.API_1 ?? "http://localhost:3001";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://ceko:ceko@localhost:5432/ceko",
});

interface Res {
  status: number;
  json: any;
  cookie: string | null;
}

async function req(
  path: string,
  opts: { method?: string; token?: string; cookie?: string; body?: unknown } = {}
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  const r = await fetch(`${A_URL}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  const setCookie = r.headers.get("set-cookie");
  const cookie = setCookie ? setCookie.split(";")[0] : null;
  return { status: r.status, json: text ? JSON.parse(text) : null, cookie };
}

async function makeUser(opts: { admin?: boolean; kind?: "ceko" | "taruna" } = {}) {
  const id = randomUUID();
  const tag = generateTag();
  const password = "correct horse battery staple";
  await pool.query(
    `INSERT INTO users (id, username, tag, password_hash, is_admin, account_kind) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, `u_${id.slice(0, 8)}`, tag, await hashPassword(password), opts.admin ?? false, opts.kind ?? "ceko"]
  );
  return { id, tag, password };
}

async function makeContacts(aId: string, bId: string) {
  await pool.query(
    `INSERT INTO contacts (requester_id, addressee_id, status, responded_at) VALUES ($1,$2,'accepted', now())`,
    [aId, bId]
  );
}

let sockets: Socket[] = [];
function openSocket(userId: string): Promise<Socket> {
  const socket = connect(A_URL, {
    transports: ["websocket"],
    auth: { token: signAccessToken(userId, 1) },
    reconnection: false,
    forceNew: true,
  });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("connect timeout")), 5000);
    socket.on("ready", () => { clearTimeout(t); resolve(socket); });
    socket.on("connect_error", (e) => { clearTimeout(t); reject(e); });
  });
}

function waitForEvent<T = any>(socket: Socket, event: string, matches: (p: T) => boolean, ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`never saw ${event} matching predicate`)), ms);
    const on = (p: T) => {
      if (!matches(p)) return;
      clearTimeout(t);
      socket.off(event, on);
      resolve(p);
    };
    socket.on(event, on);
  });
}

after(async () => {
  for (const s of sockets) s.disconnect();
  await pool.end();
});

// ---------------------------------------------------------------------------

test("login: correct credentials get an access token and a refresh cookie", async () => {
  const u = await makeUser();
  const res = await req("/auth/login", { method: "POST", body: { tag: u.tag, password: u.password } });
  assert.equal(res.status, 200);
  assert.ok(res.json.accessToken);
  assert.ok(res.cookie?.startsWith("ceko_refresh="));
});

test("login: wrong password and unknown tag get the identical error", async () => {
  const u = await makeUser();
  const wrongPassword = await req("/auth/login", { method: "POST", body: { tag: u.tag, password: "nope" } });
  const unknownTag = await req("/auth/login", { method: "POST", body: { tag: generateTag(), password: "nope" } });
  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownTag.status, 401);
  assert.equal(wrongPassword.json.error.code, unknownTag.json.error.code);
});

test("refresh: rotates the cookie and the old token can no longer be used", async () => {
  const u = await makeUser();
  const login = await req("/auth/login", { method: "POST", body: { tag: u.tag, password: u.password } });

  const first = await req("/auth/refresh", { method: "POST", cookie: login.cookie! });
  assert.equal(first.status, 200);
  assert.ok(first.cookie && first.cookie !== login.cookie);

  // Replaying the ORIGINAL cookie is theft-shaped: the legitimate client
  // already rotated past it.
  const replay = await req("/auth/refresh", { method: "POST", cookie: login.cookie! });
  assert.equal(replay.status, 401);
  assert.equal(replay.json.error.code, "TOKEN_REUSE_DETECTED");

  // And the reuse detection kills the whole family -- the token `first`
  // legitimately rotated to is now also dead.
  const afterTheft = await req("/auth/refresh", { method: "POST", cookie: first.cookie! });
  assert.equal(afterTheft.status, 401);
});

test("admin: disabling a user's account drops its live socket", async () => {
  const admin = await makeUser({ admin: true });
  const target = await makeUser();
  const adminLogin = await req("/auth/login", { method: "POST", body: { tag: admin.tag, password: admin.password } });

  const socket = await openSocket(target.id);
  const disconnected = new Promise<void>((resolve) => socket.on("disconnect", () => resolve()));

  const res = await req(`/admin/users/${target.id}`, {
    method: "PATCH",
    token: adminLogin.json.accessToken,
    body: { disabled: true },
  });
  assert.equal(res.status, 200);
  await disconnected;
});

test("admin: non-admin cannot reach admin routes", async () => {
  const u = await makeUser();
  const login = await req("/auth/login", { method: "POST", body: { tag: u.tag, password: u.password } });
  const res = await req("/admin/users", { token: login.json.accessToken });
  assert.equal(res.status, 403);
});

test("admin: can edit username and promote/demote, but cannot self-demote", async () => {
  const admin = await makeUser({ admin: true });
  const target = await makeUser();
  const adminLogin = await req("/auth/login", { method: "POST", body: { tag: admin.tag, password: admin.password } });

  const renamed = await req(`/admin/users/${target.id}`, {
    method: "PATCH", token: adminLogin.json.accessToken, body: { username: "renamed-by-admin" },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.user.username, "renamed-by-admin");

  const promoted = await req(`/admin/users/${target.id}`, {
    method: "PATCH", token: adminLogin.json.accessToken, body: { isAdmin: true },
  });
  assert.equal(promoted.json.user.is_admin, true);

  const selfDemote = await req(`/admin/users/${admin.id}`, {
    method: "PATCH", token: adminLogin.json.accessToken, body: { isAdmin: false },
  });
  assert.equal(selfDemote.status, 422);
  assert.equal(selfDemote.json.error.code, "CANNOT_SELF_DEMOTE");
});

test("lookup: malformed tag is rejected before it ever reaches the database", async () => {
  const u = await makeUser();
  const login = await req("/auth/login", { method: "POST", body: { tag: u.tag, password: u.password } });
  const res = await req("/users/lookup?tag=OOOOOO", { token: login.json.accessToken });
  assert.equal(res.status, 422);
  assert.equal(res.json.error.code, "INVALID_TAG_FORMAT");
});

test("lookup: unknown tag and a blocked user's tag both 404", async () => {
  const a = await makeUser();
  const b = await makeUser();
  const aLogin = await req("/auth/login", { method: "POST", body: { tag: a.tag, password: a.password } });

  const unknown = await req(`/users/lookup?tag=${generateTag()}`, { token: aLogin.json.accessToken });
  assert.equal(unknown.status, 404);

  await pool.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2)`, [b.id, a.id]);
  const blocked = await req(`/users/lookup?tag=${b.tag}`, { token: aLogin.json.accessToken });
  assert.equal(blocked.status, 404);
  assert.equal(blocked.json.error.code, unknown.json.error.code);
});

test("contacts: requesting each other at once auto-accepts instead of duplicating", async () => {
  const a = await makeUser();
  const b = await makeUser();
  const aLogin = await req("/auth/login", { method: "POST", body: { tag: a.tag, password: a.password } });
  const bLogin = await req("/auth/login", { method: "POST", body: { tag: b.tag, password: b.password } });

  const aRequests = await req("/contacts", { method: "POST", token: aLogin.json.accessToken, body: { tag: b.tag } });
  assert.equal(aRequests.status, 201);
  assert.equal(aRequests.json.autoAccepted, false);

  const bRequests = await req("/contacts", { method: "POST", token: bLogin.json.accessToken, body: { tag: a.tag } });
  assert.equal(bRequests.status, 200);
  assert.equal(bRequests.json.autoAccepted, true);
  assert.equal(bRequests.json.contact.id, aRequests.json.contact.id, "same row, not a second one");

  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM contacts WHERE requester_id IN ($1,$2) AND addressee_id IN ($1,$2)`, [a.id, b.id]);
  assert.equal(rows[0].n, 1);
});

test("conversations: creating a DM twice is idempotent via dm_key", async () => {
  const a = await makeUser();
  const b = await makeUser();
  await makeContacts(a.id, b.id);
  const aLogin = await req("/auth/login", { method: "POST", body: { tag: a.tag, password: a.password } });

  const first = await req("/conversations", { method: "POST", token: aLogin.json.accessToken, body: { type: "dm", userId: b.id } });
  const second = await req("/conversations", { method: "POST", token: aLogin.json.accessToken, body: { type: "dm", userId: b.id } });

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.json.conversation.id, first.json.conversation.id);

  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM conversations WHERE dm_key IS NOT NULL AND (dm_key LIKE '%'||$1||'%')`, [a.id]);
  assert.equal(rows[0].n, 1);
});

test("fallback send: REST POST dedupes on clientMessageId exactly like the socket path", async () => {
  const a = await makeUser();
  const b = await makeUser();
  await makeContacts(a.id, b.id);
  const aLogin = await req("/auth/login", { method: "POST", body: { tag: a.tag, password: a.password } });

  const conv = await req("/conversations", { method: "POST", token: aLogin.json.accessToken, body: { type: "dm", userId: b.id } });
  const convId = conv.json.conversation.id;
  const clientMessageId = randomUUID();

  const first = await req(`/conversations/${convId}/messages`, {
    method: "POST", token: aLogin.json.accessToken, body: { clientMessageId, type: "text", content: "hi" },
  });
  const second = await req(`/conversations/${convId}/messages`, {
    method: "POST", token: aLogin.json.accessToken, body: { clientMessageId, type: "text", content: "hi" },
  });

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.json.message.id, first.json.message.id);
  assert.equal(second.json.message.deduplicated, true);
});

test("read receipt: last_read_seq is monotonic", async () => {
  const a = await makeUser();
  const b = await makeUser();
  await makeContacts(a.id, b.id);
  const aLogin = await req("/auth/login", { method: "POST", body: { tag: a.tag, password: a.password } });

  const conv = await req("/conversations", { method: "POST", token: aLogin.json.accessToken, body: { type: "dm", userId: b.id } });
  const convId = conv.json.conversation.id;
  for (let i = 0; i < 3; i++) {
    await req(`/conversations/${convId}/messages`, {
      method: "POST", token: aLogin.json.accessToken,
      body: { clientMessageId: randomUUID(), type: "text", content: `m${i}` },
    });
  }

  await req(`/conversations/${convId}/read`, { method: "POST", token: aLogin.json.accessToken, body: { seq: 3 } });
  await req(`/conversations/${convId}/read`, { method: "POST", token: aLogin.json.accessToken, body: { seq: 1 } }); // out of order, must not rewind

  const { rows } = await pool.query(
    `SELECT last_read_seq FROM conversation_participants WHERE conversation_id=$1 AND user_id=$2`,
    [convId, a.id]
  );
  assert.equal(rows[0].last_read_seq, 3);
});

test("uploads: presign then PUT then a message referencing that key succeeds", async () => {
  const a = await makeUser();
  const b = await makeUser();
  await makeContacts(a.id, b.id);
  const aLogin = await req("/auth/login", { method: "POST", body: { tag: a.tag, password: a.password } });

  const presign = await req("/uploads/presign", {
    method: "POST", token: aLogin.json.accessToken, body: { filename: "photo.png", contentType: "image/png" },
  });
  assert.equal(presign.status, 200);

  const put = await fetch(presign.json.uploadUrl, { method: "PUT", body: Buffer.from("fake image bytes") });
  assert.equal(put.status, 200);

  const conv = await req("/conversations", { method: "POST", token: aLogin.json.accessToken, body: { type: "dm", userId: b.id } });
  const send = await req(`/conversations/${conv.json.conversation.id}/messages`, {
    method: "POST", token: aLogin.json.accessToken,
    body: {
      clientMessageId: randomUUID(), type: "image", content: null,
      attachments: [{ storageKey: presign.json.storageKey, fileType: "image/png", sizeBytes: 17 }],
    },
  });
  assert.equal(send.status, 201);
});

test("uploads: a message cannot reference a key that was never uploaded", async () => {
  const a = await makeUser();
  const b = await makeUser();
  await makeContacts(a.id, b.id);
  const aLogin = await req("/auth/login", { method: "POST", body: { tag: a.tag, password: a.password } });

  const conv = await req("/conversations", { method: "POST", token: aLogin.json.accessToken, body: { type: "dm", userId: b.id } });
  const send = await req(`/conversations/${conv.json.conversation.id}/messages`, {
    method: "POST", token: aLogin.json.accessToken,
    body: {
      clientMessageId: randomUUID(), type: "image", content: null,
      attachments: [{ storageKey: `${a.id}/never-uploaded.png`, fileType: "image/png", sizeBytes: 17 }],
    },
  });
  assert.equal(send.status, 422);
  assert.equal(send.json.error.code, "ATTACHMENT_NOT_UPLOADED");
});

test("presence: a contact's connect/disconnect is pushed live and reflected on the next pull", async () => {
  const a = await makeUser();
  const b = await makeUser();
  await makeContacts(a.id, b.id);
  const bLogin = await req("/auth/login", { method: "POST", body: { tag: b.tag, password: b.password } });

  // Bob is already watching when Alice connects, so he should see her come online.
  const bobSocket = await openSocket(b.id);
  const sawOnline = waitForEvent(bobSocket, "presence", (p: any) => p.userId === a.id && p.isOnline === true);
  const aliceSocket = await openSocket(a.id);
  await sawOnline;

  const whilePresent = await req("/contacts", { token: bLogin.json.accessToken });
  assert.equal(whilePresent.json.contacts.find((c: any) => c.user_id === a.id).isOnline, true);

  // Disconnecting is the debounced path (socket.ts's debounceOfflineIfLastSocket),
  // not the sweep -- the test env's short PRESENCE_OFFLINE_DEBOUNCE_MS makes this
  // fast enough to assert on directly instead of waiting for a sweep tick.
  const sawOffline = waitForEvent(bobSocket, "presence", (p: any) => p.userId === a.id && p.isOnline === false);
  aliceSocket.disconnect();
  await sawOffline;

  const afterDisconnect = await req("/contacts", { token: bLogin.json.accessToken });
  assert.equal(afterDisconnect.json.contacts.find((c: any) => c.user_id === a.id).isOnline, false);
});

test("presence: a non-contact's connect/disconnect is never pushed", async () => {
  const a = await makeUser();
  const stranger = await makeUser(); // deliberately not made a contact of a

  const aSocket = await openSocket(a.id);
  const sawAnything = waitForEvent(aSocket, "presence", () => true, 800).then(
    () => true,
    () => false
  );
  const strangerSocket = await openSocket(stranger.id);
  assert.equal(await sawAnything, false, "a stranger connecting must not reach a's socket");
  strangerSocket.disconnect();
});

// ---------------------------------------------------------------------------
// Account kinds: Taruna (ephemeral, shared-device) vs Ceko (persistent)
// ---------------------------------------------------------------------------

test("taruna: login issues no refresh cookie and wipes conversation membership only", async () => {
  const ceko = await makeUser({ kind: "ceko" });
  const taruna = await makeUser({ kind: "taruna" });
  await makeContacts(ceko.id, taruna.id);

  const cekoLogin = await req("/auth/login", { method: "POST", body: { tag: ceko.tag, password: ceko.password } });
  const dm = await req("/conversations", {
    method: "POST", token: cekoLogin.json.accessToken, body: { type: "dm", userId: taruna.id },
  });
  assert.equal(dm.status, 201);

  // The wipe runs on every login, including this very first one -- Ceko
  // created the DM (and so Taruna's participant row) before Taruna ever
  // logged in at all, and that's still wiped away immediately.
  const firstLogin = await req("/auth/login", { method: "POST", body: { tag: taruna.tag, password: taruna.password } });
  assert.equal(firstLogin.status, 200);
  assert.equal(firstLogin.cookie, null, "a taruna login must never set a session cookie");
  assert.equal(firstLogin.json.user.accountKind, "taruna");

  const conversations = await req("/conversations", { token: firstLogin.json.accessToken });
  assert.equal(conversations.json.conversations.length, 0, "conversation membership wiped on login");

  // Contacts are NOT wiped -- see taruna.ts for why: a contact is one row
  // shared by both sides, and deleting "just Taruna's half" would delete
  // Ceko's view of it too, which breaks "Ceko is never cleared."
  const contacts = await req("/contacts", { token: firstLogin.json.accessToken });
  assert.equal(contacts.json.contacts.length, 1, "contacts persist across logins, unlike conversation history");

  // Ceko's own side is completely unaffected -- it still sees the contact
  // and the conversation exactly as before.
  const cekoContacts = await req("/contacts", { token: cekoLogin.json.accessToken });
  assert.equal(cekoContacts.json.contacts.length, 1, "the wipe never touches the other side's data");
  const cekoConversations = await req("/conversations", { token: cekoLogin.json.accessToken });
  assert.equal(cekoConversations.json.conversations.length, 1);
});

test("ceko: login is unaffected -- persistent cookie, nothing wiped", async () => {
  const a = await makeUser({ kind: "ceko" });
  const b = await makeUser({ kind: "ceko" });
  await makeContacts(a.id, b.id);
  const login1 = await req("/auth/login", { method: "POST", body: { tag: a.tag, password: a.password } });
  assert.ok(login1.cookie?.startsWith("ceko_refresh="));

  const login2 = await req("/auth/login", { method: "POST", body: { tag: a.tag, password: a.password } });
  const contacts = await req("/contacts", { token: login2.json.accessToken });
  assert.equal(contacts.json.contacts.length, 1, "a ceko login never wipes contacts");
});

test("pending: a message sent to an offline taruna survives their wipe and needs an explicit request", async () => {
  const ceko = await makeUser({ kind: "ceko" });
  const taruna = await makeUser({ kind: "taruna" });
  await makeContacts(ceko.id, taruna.id);

  const cekoLogin = await req("/auth/login", { method: "POST", body: { tag: ceko.tag, password: ceko.password } });
  const dm = await req("/conversations", {
    method: "POST", token: cekoLogin.json.accessToken, body: { type: "dm", userId: taruna.id },
  });
  const convId = dm.json.conversation.id;

  // Taruna is offline (never even logs in yet) when this arrives.
  const sent = await req(`/conversations/${convId}/messages`, {
    method: "POST", token: cekoLogin.json.accessToken,
    body: { clientMessageId: randomUUID(), type: "text", content: "are you there?" },
  });
  assert.equal(sent.status, 201);

  // Taruna logs in -- wipes the membership row that never even saw the
  // message. The contact relationship itself survives the wipe (see
  // taruna.ts), so no re-request/re-accept is needed here.
  const tarunaLogin = await req("/auth/login", { method: "POST", body: { tag: taruna.tag, password: taruna.password } });
  assert.equal((await req("/conversations", { token: tarunaLogin.json.accessToken })).json.conversations.length, 0);

  // Re-creating the DM re-joins the SAME conversation (same dm_key) rather
  // than starting a new one, and gates everything already in it.
  const rejoin = await req("/conversations", {
    method: "POST", token: tarunaLogin.json.accessToken, body: { type: "dm", userId: ceko.id },
  });
  assert.equal(rejoin.status, 200, "re-joins the existing conversation, doesn't create a new one");
  assert.equal(rejoin.json.conversation.id, convId);

  const gated = await req(`/conversations/${convId}/messages`, { token: tarunaLogin.json.accessToken });
  assert.equal(gated.json.pending, true);
  assert.equal(gated.json.messages.length, 0, "the pre-existing message is hidden until requested");

  const released = await req(`/conversations/${convId}/request-pending`, { method: "POST", token: tarunaLogin.json.accessToken });
  assert.equal(released.status, 200);

  const afterRelease = await req(`/conversations/${convId}/messages`, { token: tarunaLogin.json.accessToken });
  assert.equal(afterRelease.json.pending, false);
  assert.equal(afterRelease.json.messages.length, 1);
  assert.equal(afterRelease.json.messages[0].content, "are you there?");
});

test("pending: a plain Ceko-Ceko conversation is never gated", async () => {
  const a = await makeUser({ kind: "ceko" });
  const b = await makeUser({ kind: "ceko" });
  await makeContacts(a.id, b.id);
  const aLogin = await req("/auth/login", { method: "POST", body: { tag: a.tag, password: a.password } });

  const dm = await req("/conversations", { method: "POST", token: aLogin.json.accessToken, body: { type: "dm", userId: b.id } });
  await req(`/conversations/${dm.json.conversation.id}/messages`, {
    method: "POST", token: aLogin.json.accessToken,
    body: { clientMessageId: randomUUID(), type: "text", content: "hello" },
  });

  const history = await req(`/conversations/${dm.json.conversation.id}/messages`, { token: aLogin.json.accessToken });
  assert.equal(history.json.pending, false);
  assert.equal(history.json.messages.length, 1, "never gated -- visible immediately, same as always");
});
