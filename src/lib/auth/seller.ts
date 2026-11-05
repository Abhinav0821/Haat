import { createHash, timingSafeEqual } from "node:crypto";
import { readSessionCookie, sellerAreaConfigured, verifySessionToken } from "./session";

/**
 * Data-access-layer check for seller APIs. The Proxy only does an optimistic
 * redirect; every seller route calls this before touching seller data.
 */
export async function requireSeller(request: Request): Promise<Response | null> {
  if (!sellerAreaConfigured()) {
    return Response.json({ error: "Seller area is locked: set SELLER_PASSCODE." }, { status: 503 });
  }
  const ok = await verifySessionToken(readSessionCookie(request.headers.get("cookie")));
  return ok ? null : Response.json({ error: "Please sign in" }, { status: 401 });
}

/** Constant-time passcode comparison (hash first so lengths always match). */
export function passcodeMatches(attempt: string): boolean {
  const expected = process.env.SELLER_PASSCODE;
  if (!expected) return false;
  const a = createHash("sha256").update(attempt).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// Simple per-client limiter for login attempts (per process).
const attempts = new Map<string, number[]>();
export function loginAllowed(clientKey: string, max = 5, windowMs = 15 * 60_000): boolean {
  const now = Date.now();
  const recent = (attempts.get(clientKey) ?? []).filter((t) => now - t < windowMs);
  attempts.set(clientKey, recent);
  return recent.length < max;
}
export function recordFailedLogin(clientKey: string) {
  attempts.set(clientKey, [...(attempts.get(clientKey) ?? []), Date.now()]);
}
export function clientKeyOf(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}
