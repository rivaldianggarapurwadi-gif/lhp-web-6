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

async function makeUser(opts: { admin?: boolean } = {}) {
  const id = randomUUID();
  const tag = generateTag();
  const password = "correct horse battery staple";
  await pool.query(
    `INSERT INTO users (id, username, tag, password_hash, is_admin) VALUES ($1,$2,$3,$4,$5)`,
    [id, `u_${id.slice(0, 8)}`, tag, await hashPassword(password), opts.admin ?? false]
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
