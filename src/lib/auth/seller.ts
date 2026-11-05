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

// Login attempts: 5 failures per client per 15 minutes, stored in the database
// so the limit holds across serverless instances.
const LOGIN_WINDOW_MS = 15 * 60_000;
export async function loginAllowed(clientKey: string, max = 5): Promise<boolean> {
  const { allowed } = await import("@/lib/rate-limit");
  return allowed(`login:${clientKey}`, max, LOGIN_WINDOW_MS);
}
export async function recordFailedLogin(clientKey: string) {
  const { record } = await import("@/lib/rate-limit");
  await record(`login:${clientKey}`);
}

/**
 * The client's IP for rate limiting. Only trust headers the platform sets:
 * on Vercel, x-real-ip / x-forwarded-for are overwritten by the edge; locally
 * (behind a Cloudflare tunnel) cf-connecting-ip. A client-sent cf-connecting-ip
 * is ignored on Vercel, so it can't be used to dodge limits.
 */
export function clientKeyOf(request: Request): string {
  const h = request.headers;
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (process.env.VERCEL) return h.get("x-real-ip") ?? forwarded ?? "unknown";
  return h.get("cf-connecting-ip") ?? forwarded ?? "local";
}
