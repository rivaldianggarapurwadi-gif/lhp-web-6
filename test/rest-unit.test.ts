import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword, verifyPassword } from "../src/password.js";
import { TAG_ALPHABET, TAG_FORMAT, generateTag, isValidTagFormat, normalizeTag } from "../src/tag.js";
import { parseCookies, serializeCookie, clearedCookie } from "../src/cookies.js";

test("password: correct password verifies, wrong password does not", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("correct horse battery staple", hash), true);
  assert.equal(await verifyPassword("wrong password", hash), false);
});

test("password: two hashes of the same password differ (random salt)", async () => {
  const a = await hashPassword("same-password");
  const b = await hashPassword("same-password");
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("same-password", a), true);
  assert.equal(await verifyPassword("same-password", b), true);
});

test("password: malformed stored hash fails closed, not throws", async () => {
  assert.equal(await verifyPassword("anything", "not-a-real-hash"), false);
  assert.equal(await verifyPassword("anything", "scrypt$16384$8$1$deadbeef$00"), false);
});

test("tag: generator only ever produces the checked alphabet", () => {
  for (let i = 0; i < 200; i++) {
    const t = generateTag();
    assert.equal(t.length, 6);
    assert.equal(isValidTagFormat(t), true);
    for (const ch of t) assert.ok(TAG_ALPHABET.includes(ch), `${ch} not in alphabet`);
  }
});

test("tag: format rejects confusable characters excluded from the alphabet", () => {
  // O, I, L, U are excluded -- both members of every confusable pair, not
  // just the digit half. A regex that only strips the digit side quietly
  // re-admits L; assert directly against the characters that must be absent.
  for (const bad of ["O", "I", "L", "U", "0", "1"]) {
    assert.equal(TAG_FORMAT.test(`AAAAA${bad}`), false, `${bad} should not be valid`);
  }
});

test("tag: normalizeTag trims and upper-cases", () => {
  assert.equal(normalizeTag("  ab3d7h  "), "AB3D7H");
});

test("cookies: round-trips through parse/serialize", () => {
  const header = serializeCookie("ceko_refresh", "a b&c", { path: "/auth", maxAgeSeconds: 60 });
  const nameValue = header.split(";")[0];
  const parsed = parseCookies(nameValue);
  assert.equal(parsed.ceko_refresh, "a b&c");
});

test("cookies: serialize carries the flags callers rely on", () => {
  const header = serializeCookie("x", "y", { path: "/auth", sameSite: "Lax", secure: true });
  assert.match(header, /Path=\/auth/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
});

test("cookies: clearedCookie sets Max-Age=0", () => {
  assert.match(clearedCookie("x"), /Max-Age=0/);
});

test("cookies: parseCookies handles multiple cookies and missing header", () => {
  assert.deepEqual(parseCookies(undefined), {});
  const parsed = parseCookies("a=1; b=2; c=3");
  assert.deepEqual(parsed, { a: "1", b: "2", c: "3" });
});
