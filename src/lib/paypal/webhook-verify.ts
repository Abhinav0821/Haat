import { createVerify } from "node:crypto";
import { crc32 } from "node:zlib";

/**
 * Offline verification of PayPal webhook signatures.
 *
 * PayPal signs `<transmissionId>|<transmissionTime>|<webhookId>|<crc32(rawBody)>`
 * with SHA256withRSA; the signing certificate is published at `paypal-cert-url`.
 * We verify against the *raw* request body (re-serialised JSON may not match)
 * and only trust certificates served from paypal.com over HTTPS.
 */

export type VerifyResult = { valid: true } | { valid: false; reason: string };

export type CertLoader = (url: string) => Promise<string>;

const certCache = new Map<string, Promise<string>>();

export const fetchCert: CertLoader = (url) => {
  let pending = certCache.get(url);
  if (!pending) {
    pending = fetch(url).then(async (res) => {
      if (!res.ok) throw new Error(`cert fetch ${res.status}`);
      return res.text();
    });
    pending.catch(() => certCache.delete(url)); // don't cache failures
    certCache.set(url, pending);
  }
  return pending;
};

export function isTrustedCertUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && (u.hostname === "paypal.com" || u.hostname.endsWith(".paypal.com"));
  } catch {
    return false;
  }
}

export async function verifyPayPalWebhook({
  headers,
  rawBody,
  webhookId,
  loadCert = fetchCert,
}: {
  headers: Headers;
  rawBody: string;
  webhookId: string;
  loadCert?: CertLoader;
}): Promise<VerifyResult> {
  const transmissionId = headers.get("paypal-transmission-id");
  const transmissionTime = headers.get("paypal-transmission-time");
  const signature = headers.get("paypal-transmission-sig");
  const certUrl = headers.get("paypal-cert-url");
  const authAlgo = headers.get("paypal-auth-algo");

  if (!transmissionId || !transmissionTime || !signature || !certUrl) {
    return { valid: false, reason: "missing PayPal transmission headers" };
  }
  if (authAlgo && authAlgo !== "SHA256withRSA") {
    return { valid: false, reason: `unsupported auth algo ${authAlgo}` };
  }
  if (!isTrustedCertUrl(certUrl)) {
    return { valid: false, reason: `untrusted cert url ${certUrl}` };
  }

  const checksum = crc32(Buffer.from(rawBody, "utf8")) >>> 0;
  const message = `${transmissionId}|${transmissionTime}|${webhookId}|${checksum}`;

  let cert: string;
  try {
    cert = await loadCert(certUrl);
  } catch (e) {
    return { valid: false, reason: `could not load cert: ${(e as Error).message}` };
  }

  try {
    const ok = createVerify("sha256").update(message).verify(cert, signature, "base64");
    return ok ? { valid: true } : { valid: false, reason: "signature mismatch" };
  } catch (e) {
    return { valid: false, reason: `verify error: ${(e as Error).message}` };
  }
}
