import { after, test } from "node:test";
import assert from "node:assert/strict";

process.env.SELLER_PASSCODE = "246810";
process.env.PGLITE_DIR = "memory://";
process.env.PAYPAL_CLIENT_ID ??= "test";
process.env.PAYPAL_CLIENT_SECRET ??= "test";
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

test("login attempts are rate-limited per client (stored in the database)", async () => {
  const ip = `1.2.3.${Math.floor(Math.random() * 250)}`;
  for (let i = 0; i < 5; i++) await recordFailedLogin(ip);
  assert.equal(await loginAllowed(ip), false);
  assert.equal(await loginAllowed("5.6.7.8"), true);
});

test("rate-limit window slides: old hits stop counting", async () => {
  const { hit } = await import("@/lib/rate-limit");
  const key = `t:${Math.random()}`;
  const t0 = new Date(Date.now() - 120_000);
  assert.equal(await hit(key, 2, 60_000, t0), true);
  assert.equal(await hit(key, 2, 60_000, t0), true);
  assert.equal(await hit(key, 2, 60_000, t0), false, "third within the window is refused");
  assert.equal(await hit(key, 2, 60_000), true, "two minutes later the window has moved on");
});

test("client IP: a spoofed cf-connecting-ip is ignored on Vercel", async () => {
  const { clientKeyOf } = await import("@/lib/auth/seller");
  const req = new Request("https://x/", { headers: { "cf-connecting-ip": "6.6.6.6", "x-real-ip": "9.9.9.9" } });
  process.env.VERCEL = "1";
  assert.equal(clientKeyOf(req), "9.9.9.9");
  delete process.env.VERCEL;
  assert.equal(clientKeyOf(req), "6.6.6.6", "locally, behind the Cloudflare tunnel, cf-connecting-ip is the client");
});

after(async () => (await import("@/db")).closeDb());

test("cookie parsing", () => {
  assert.equal(readSessionCookie("a=1; haat_seller=abc.def; b=2"), "abc.def");
  assert.equal(readSessionCookie("a=1"), null);
  assert.equal(readSessionCookie(null), null);
});
