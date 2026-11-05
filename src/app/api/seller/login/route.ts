import { z } from "zod";
import { clientKeyOf, loginAllowed, passcodeMatches, recordFailedLogin } from "@/lib/auth/seller";
import { createSessionToken, SESSION_COOKIE, SESSION_TTL_MS, sellerAreaConfigured } from "@/lib/auth/session";

const Body = z.object({ passcode: z.string().min(4).max(32) });

export async function POST(request: Request) {
  if (!sellerAreaConfigured()) {
    return Response.json({ error: "Seller area is locked: set SELLER_PASSCODE." }, { status: 503 });
  }
  const client = clientKeyOf(request);
  if (!loginAllowed(client)) {
    return Response.json({ error: "बहुत कोशिशें हो गईं। 15 मिनट बाद फिर कोशिश करें · Too many attempts, try again in 15 minutes." }, { status: 429 });
  }
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !passcodeMatches(parsed.data.passcode)) {
    recordFailedLogin(client);
    return Response.json({ error: "पासकोड ग़लत है · Wrong passcode" }, { status: 401 });
  }
  const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  const cookie = [
    `${SESSION_COOKIE}=${encodeURIComponent(await createSessionToken())}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
  return Response.json({ ok: true }, { headers: { "Set-Cookie": cookie } });
}
