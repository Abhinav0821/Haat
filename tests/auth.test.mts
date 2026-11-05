import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SELLER_PASSCODE = "246810";
process.env.SESSION_SECRET = "test-secret-not-for-production";

const { createSessionToken, verifySessionToken, readSessionCookie, SESSION_TTL_MS } = await import("@/lib/auth/session");
const { passcodeMatches, loginAllowed, recordFailedLogin } = await import("@/lib/auth/seller");

test("a fresh session token verifies", async () => {
  assert.equal(await verifySessionToken(await createSessionToken()), true);
});

test("tampered, forged, expired or missing tokens are rejected", async () => {
  const t = await createSessionToken();
  const [exp, sig] = t.split(".");
  assert.equal(await verifySessionToken(`${Number(exp) + 1}.${sig}`), false, "extended expiry");
  assert.equal(await verifySessionToken(`${exp}.${sig.slice(0, -2)}xx`), false, "altered signature");
  assert.equal(await verifySessionToken("9999999999999.AAAA"), false, "forged");
  assert.equal(await verifySessionToken(await createSessionToken(Date.now() - SESSION_TTL_MS - 1000)), false, "expired");
  assert.equal(await verifySessionToken(undefined), false);
  assert.equal(await verifySessionToken("garbage"), false);
});

test("tokens signed with another secret are rejected", async () => {
  const t = await createSessionToken();
  process.env.SESSION_SECRET = "a-different-secret";
  assert.equal(await verifySessionToken(t), false);
  process.env.SESSION_SECRET = "test-secret-not-for-production";
});

test("without SELLER_PASSCODE the seller area stays locked", async () => {
  const t = await createSessionToken();
  delete process.env.SELLER_PASSCODE;
  assert.equal(await verifySessionToken(t), false);
  assert.equal(passcodeMatches("246810"), false);
  process.env.SELLER_PASSCODE = "246810";
});

test("passcode check", () => {
  assert.equal(passcodeMatches("246810"), true);
  assert.equal(passcodeMatches("246811"), false);
  assert.equal(passcodeMatches(""), false);
});

test("login attempts are rate-limited per client", () => {
  for (let i = 0; i < 5; i++) recordFailedLogin("1.2.3.4");
  assert.equal(loginAllowed("1.2.3.4"), false);
  assert.equal(loginAllowed("5.6.7.8"), true);
});

test("cookie parsing", () => {
  assert.equal(readSessionCookie("a=1; haat_seller=abc.def; b=2"), "abc.def");
  assert.equal(readSessionCookie("a=1"), null);
  assert.equal(readSessionCookie(null), null);
});
