import { test } from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { crc32 } from "node:zlib";
import { isTrustedCertUrl, verifyPayPalWebhook } from "@/lib/paypal/webhook-verify";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const loadCert = async () => publicPem;

const WEBHOOK_ID = "8PT597110X687430LKGECATA";
const CERT_URL = "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-test";
const body = JSON.stringify({ id: "WH-1", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "ORDER1" } });

function signedHeaders(rawBody: string, webhookId = WEBHOOK_ID, overrides: Record<string, string> = {}) {
  const transmissionId = "b2384410-f8d2-11ed-8f8d-6b5a5e7f0c11";
  const transmissionTime = "2026-11-05T10:00:00Z";
  const message = `${transmissionId}|${transmissionTime}|${webhookId}|${crc32(Buffer.from(rawBody)) >>> 0}`;
  const sig = createSign("sha256").update(message).sign(privateKey, "base64");
  return new Headers({
    "paypal-transmission-id": transmissionId,
    "paypal-transmission-time": transmissionTime,
    "paypal-transmission-sig": sig,
    "paypal-cert-url": CERT_URL,
    "paypal-auth-algo": "SHA256withRSA",
    ...overrides,
  });
}

test("accepts a correctly signed event", async () => {
  const r = await verifyPayPalWebhook({ headers: signedHeaders(body), rawBody: body, webhookId: WEBHOOK_ID, loadCert });
  assert.deepEqual(r, { valid: true });
});

test("rejects a tampered body", async () => {
  const tampered = body.replace("ORDER1", "ORDER2");
  const r = await verifyPayPalWebhook({ headers: signedHeaders(body), rawBody: tampered, webhookId: WEBHOOK_ID, loadCert });
  assert.equal(r.valid, false);
});

test("rejects an event signed for a different webhook id", async () => {
  const r = await verifyPayPalWebhook({
    headers: signedHeaders(body, "SOMEONE-ELSES-WEBHOOK"),
    rawBody: body,
    webhookId: WEBHOOK_ID,
    loadCert,
  });
  assert.equal(r.valid, false);
});

test("never fetches certificates from non-PayPal hosts", async () => {
  let fetched = false;
  const r = await verifyPayPalWebhook({
    headers: signedHeaders(body, WEBHOOK_ID, { "paypal-cert-url": "https://evil.example.com/cert.pem" }),
    rawBody: body,
    webhookId: WEBHOOK_ID,
    loadCert: async () => {
      fetched = true;
      return publicPem;
    },
  });
  assert.equal(r.valid, false);
  assert.equal(fetched, false);
});

test("rejects requests without PayPal headers", async () => {
  const r = await verifyPayPalWebhook({ headers: new Headers(), rawBody: body, webhookId: WEBHOOK_ID, loadCert });
  assert.deepEqual(r, { valid: false, reason: "missing PayPal transmission headers" });
});

test("cert URL allowlist", () => {
  assert.equal(isTrustedCertUrl("https://api.paypal.com/v1/notifications/certs/X"), true);
  assert.equal(isTrustedCertUrl("https://api.sandbox.paypal.com/v1/notifications/certs/X"), true);
  assert.equal(isTrustedCertUrl("http://api.paypal.com/cert"), false);
  assert.equal(isTrustedCertUrl("https://paypal.com.evil.io/cert"), false);
  assert.equal(isTrustedCertUrl("https://evilpaypal.com/cert"), false);
  assert.equal(isTrustedCertUrl("not a url"), false);
});
