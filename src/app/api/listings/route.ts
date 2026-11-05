import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { env } from "@/lib/env";
import { createCatalogProduct } from "@/lib/paypal/catalog";
import { PayPalApiError } from "@/lib/paypal/client";
import { getDemoStore } from "@/lib/store";

/** POST: seller-confirmed listing → PayPal catalog product + live product in our store. */

const PublishSchema = z.object({
  draftId: z.string().uuid(), // client-generated; makes publishing idempotent
  title: z.string().trim().min(3).max(127),
  description: z.string().trim().min(10).max(2000),
  priceCents: z.number().int().min(100).max(1_000_000),
  category: z.string().max(40),
  attributes: z.record(z.string(), z.unknown()).default({}),
  imageIds: z.array(z.string().uuid()).max(4).default([]),
  voiceNoteId: z.string().uuid().nullable().default(null),
  sellerTranscript: z.string().max(4000).nullable().default(null),
  sellerTranslation: z.string().max(4000).nullable().default(null),
  sellerLanguage: z.string().max(40).nullable().default(null),
});

export async function POST(request: Request) {
  const parsed = PublishSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid listing", issues: parsed.error.issues }, { status: 400 });
  }
  const input = parsed.data;
  const store = await getDemoStore();
  const d = await db();

  // Already published with this draft id? Return the existing product.
  const [already] = await d.select().from(schema.products).where(eq(schema.products.publishKey, input.draftId));
  if (already) return Response.json({ product: already, paypalProductId: already.paypalProductId }, { status: 200 });

  // Only allow media that belongs to this store.
  const mediaIds = [...input.imageIds, ...(input.voiceNoteId ? [input.voiceNoteId] : [])];
  if (mediaIds.length) {
    const owned = await d
      .select({ id: schema.media.id })
      .from(schema.media)
      .where(and(eq(schema.media.storeId, store.id), inArray(schema.media.id, mediaIds)));
    if (owned.length !== mediaIds.length) return Response.json({ error: "unknown media" }, { status: 400 });
  }

  const appUrl = env().APP_URL;
  let paypalProduct;
  try {
    paypalProduct = await createCatalogProduct({
      name: input.title,
      description: input.description,
      imageUrl: input.imageIds[0] ? `${appUrl}/api/media/${input.imageIds[0]}` : undefined,
      homeUrl: `${appUrl}/s/${store.slug}`,
      requestId: `listing-${input.draftId}`,
    });
  } catch (e) {
    console.error("[listings] PayPal catalog create failed:", e);
    const msg = e instanceof PayPalApiError ? `PayPal: ${e.message}` : "PayPal is unreachable";
    return Response.json({ error: msg }, { status: 502 });
  }

  const [product] = await d
    .insert(schema.products)
    .values({
      storeId: store.id,
      paypalProductId: paypalProduct.id,
      publishKey: input.draftId,
      title: input.title,
      description: input.description,
      priceCents: input.priceCents,
      currency: "USD",
      images: input.imageIds,
      voiceNoteId: input.voiceNoteId,
      sellerTranscript: input.sellerTranscript,
      sellerTranslation: input.sellerTranslation,
      sellerLanguage: input.sellerLanguage,
      attributes: { ...input.attributes, category: input.category },
      status: "live",
    })
    .onConflictDoNothing({ target: schema.products.publishKey })
    .returning();

  if (!product) {
    // Lost a race with a concurrent identical request — return the winner.
    const [winner] = await d.select().from(schema.products).where(eq(schema.products.publishKey, input.draftId));
    return Response.json({ product: winner, paypalProductId: winner?.paypalProductId }, { status: 200 });
  }
  return Response.json({ product, paypalProductId: paypalProduct.id }, { status: 201 });
}
