import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { clientKeyOf, loginAllowed, recordFailedLogin } from "@/lib/auth/seller";
import { errorResponse } from "@/lib/custom/http";
import { createCustomRequest } from "@/lib/custom/requests";

/** A buyer describes what they'd like made. Public; rate-limited because each request costs an AI call. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { slug?: string; text?: string; name?: string; email?: string } | null;
  if (!body?.slug || typeof body.text !== "string") return Response.json({ error: "describe what you'd like made" }, { status: 400 });
  const key = `custom:${clientKeyOf(request)}`;
  if (!loginAllowed(key, 10, 60 * 60_000)) return Response.json({ error: "Too many requests — please try again later." }, { status: 429 });
  recordFailedLogin(key); // counts every request toward the limit
  const d = await db();
  const [store] = await d.select().from(schema.stores).where(eq(schema.stores.slug, body.slug));
  if (!store) return Response.json({ error: "shop not found" }, { status: 404 });
  try {
    const r = await createCustomRequest(store.id, { buyerText: body.text, buyerName: body.name, buyerEmail: body.email, channel: "web" });
    return Response.json({ id: r.id, url: `/s/${store.slug}/custom/${r.id}` }, { status: 201 });
  } catch (e) {
    return errorResponse(e, "custom request");
  }
}
