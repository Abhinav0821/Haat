import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

/**
 * Ed25519 signing for Maker Evidence records. Anyone can verify a passport with the
 * public key (served at /api/passport/public-key); only Haat can issue one.
 *
 * Key: PASSPORT_SIGNING_SEED (any secret string) → SHA-256 → 32-byte Ed25519 seed.
 * Falls back to a seed derived from the PayPal client secret for local demos.
 */

// PKCS#8 DER prefix for an Ed25519 private key; the 32-byte seed follows it.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

let cached: { priv: KeyObject; pub: KeyObject } | null = null;

function keys() {
  if (cached) return cached;
  const material = process.env.PASSPORT_SIGNING_SEED || `haat-passport-v1:${process.env.PAYPAL_CLIENT_SECRET ?? "dev"}`;
  const seed = createHash("sha256").update(material).digest();
  const priv = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  cached = { priv, pub: createPublicKey(priv) };
  return cached;
}

/** Stable JSON: sorted keys, no whitespace — what gets signed. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function signPayload(payload: Record<string, unknown>): string {
  return sign(null, Buffer.from(canonical(payload)), keys().priv).toString("base64url");
}

export function verifyPayload(payload: Record<string, unknown>, signature: string): boolean {
  try {
    return verify(null, Buffer.from(canonical(payload)), keys().pub, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export function publicKeyPem(): string {
  return keys().pub.export({ type: "spki", format: "pem" }).toString();
}
