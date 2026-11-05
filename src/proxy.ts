import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";

/**
 * Optimistic gate for the seller area: unauthenticated visitors are sent to the
 * PIN screen (pages) or get 401 (APIs). Each seller API route re-checks the
 * session itself — this is a convenience, not the only lock.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (pathname === "/seller/login" || pathname === "/api/seller/login" || pathname === "/api/seller/logout") {
    return NextResponse.next();
  }
  if (await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Please sign in" }, { status: 401 });
  }
  const login = new URL("/seller/login", request.url);
  login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/seller/:path*", "/api/seller/:path*", "/api/listings", "/api/listings/:path*"],
};
