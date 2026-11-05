/**
 * Seller session: a signed, expiring cookie. Uses only Web Crypto so it runs in
 * the Proxy (optimistic redirect) and in route handlers (the real check).
 *
 * Cookie value: `<expiresAtMs>.<base64url(HMAC-SHA256(secret, expiresAtMs))>`
 */

export const SESSION_COOKIE = "haat_seller";
export const SESSION_TTL_MS = 30 * 24 * 3600_000;

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Secret for signing: SESSION_SECRET, else derived from passcode + PayPal secret. Null = seller area locked. */
function secretMaterial(): string | null {
  const passcode = process.env.SELLER_PASSCODE;
  if (!passcode) return null;
  return process.env.SESSION_SECRET || `${passcode}:${process.env.PAYPAL_CLIENT_SECRET ?? ""}:haat-seller-v1`;
}

async function key(usage: "sign" | "verify"): Promise<CryptoKey | null> {
  const material = secretMaterial();
  if (!material) return null;
  return crypto.subtle.importKey("raw", enc.encode(material), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export function sellerAreaConfigured(): boolean {
  return Boolean(process.env.SELLER_PASSCODE);
}

export async function createSessionToken(now = Date.now()): Promise<string> {
  const k = await key("sign");
  if (!k) throw new Error("SELLER_PASSCODE is not set");
  const exp = String(now + SESSION_TTL_MS);
  return `${exp}.${b64url(await crypto.subtle.sign("HMAC", k, enc.encode(exp)))}`;
}

export async function verifySessionToken(token: string | undefined | null, now = Date.now()): Promise<boolean> {
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !/^\d{13}$/.test(exp) || Number(exp) < now) return false;
  const k = await key("verify");
  if (!k) return false;
  try {
    // crypto.subtle.verify compares in constant time.
    return await crypto.subtle.verify("HMAC", k, fromB64url(sig), enc.encode(exp));
  } catch {
    return false;
  }
}

/** Read our cookie from a raw Cookie header. */
export function readSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}
