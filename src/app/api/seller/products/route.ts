import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireSeller } from "@/lib/auth/seller";
import { getPassportsFor } from "@/lib/passport/passport";
import { getDemoStore } from "@/lib/store";

/** The seller's live pieces with their Maker Evidence status. */
export async function GET(request: Request) {
  const denied = await requireSeller(request);
  if (denied) return denied;
  const store = await getDemoStore();
  const d = await db();
  const products = await d
    .select()
    .from(schema.products)
    .where(eq(schema.products.storeId, store.id))
    .orderBy(desc(schema.products.createdAt));
  const live = products.filter((p) => p.status === "live");
  const passports = await getPassportsFor(live.map((p) => p.id));
  return Response.json({
    products: live.map((p) => {
      const pp = passports.get(p.id);
      return {
        id: p.id,
        title: p.title,
        priceCents: p.priceCents,
        image: p.images[0] ?? null,
        passport: pp
          ? { status: pp.status, code: pp.status === "awaiting_photo" ? pp.code : null, verifiedAt: pp.verifiedAt?.toISOString() ?? null, flags: (pp.checks as { flags?: unknown[] } | null)?.flags ?? [] }
          : null,
      };
    }),
    storeSlug: store.slug,
  });
}
