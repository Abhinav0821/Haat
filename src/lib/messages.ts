import { and, asc, desc, eq, or } from "drizzle-orm";
import { generateText, Output } from "ai";
import { z } from "zod";
import { db, schema } from "@/db";
import { model } from "@/lib/ai/model";
import { shieldBuyerMessage } from "@/lib/shield/scam-shield";
import { sellerLanguage } from "@/lib/store";

/**
 * Buyer ↔ seller messaging. Every message is stored in both languages:
 * buyers write in English (or anything), the maker reads and replies in her own
 * language, by voice or text. Buyer messages pass through Scam Shield first.
 */

export class MessageError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const MAX_LEN = 2000;

export async function postBuyerMessage(input: {
  orderId?: string;
  productId?: string;
  text: string;
  buyerEmail?: string;
  channel?: "web" | "mcp";
}) {
  const text = input.text.trim();
  if (text.length < 2 || text.length > MAX_LEN) throw new MessageError("message must be 2–2000 characters");
  const d = await db();

  let storeId: string;
  let storeSlug: string;
  let order: typeof schema.orders.$inferSelect | null = null;
  let productId = input.productId ?? null;

  if (input.orderId) {
    const [row] = await d
      .select({ order: schema.orders, store: schema.stores })
      .from(schema.orders)
      .innerJoin(schema.stores, eq(schema.stores.id, schema.orders.storeId))
      .where(eq(schema.orders.id, input.orderId));
    if (!row) throw new MessageError("unknown order", 404);
    ({ order } = row);
    storeId = row.store.id;
    storeSlug = row.store.slug;
    productId ??= row.order.items[0]?.productId ?? null;
  } else if (input.productId) {
    const [row] = await d
      .select({ store: schema.stores })
      .from(schema.products)
      .innerJoin(schema.stores, eq(schema.stores.id, schema.products.storeId))
      .where(eq(schema.products.id, input.productId));
    if (!row) throw new MessageError("unknown product", 404);
    storeId = row.store.id;
    storeSlug = row.store.slug;
  } else {
    throw new MessageError("orderId or productId required");
  }

  const language = sellerLanguage(storeSlug);
  const { read, verdict } = await shieldBuyerMessage(text, {
    targetLanguage: language,
    order: order
      ? { paypalOrderId: order.paypalOrderId, status: order.status, hasPayPalAddress: !!order.shippingAddress }
      : null,
  });

  const [saved] = await d
    .insert(schema.messages)
    .values({
      storeId,
      orderId: order?.id ?? null,
      productId,
      direction: "buyer_to_seller",
      channel: input.channel ?? "web",
      buyerEmail: input.buyerEmail ?? null,
      originalText: text,
      originalLanguage: read?.language ?? null,
      translatedText: read?.translation ?? null,
      translatedLanguage: read ? language : null,
      shield: verdict,
    })
    .returning();

  return { message: saved, storeSlug, verdict };
}

const ReplySchema = z.object({
  transcript: z.string().describe("What the seller said/wrote, verbatim, in her own language and script."),
  language: z.string().describe("The seller's language, e.g. 'Hindi'."),
  english: z.string().describe("Warm, faithful English translation for the international buyer. No additions."),
});

export async function postSellerReply(
  parentId: string,
  input: { text?: string; audio?: { data: Uint8Array; mediaType: string } },
) {
  const d = await db();
  const [parent] = await d.select().from(schema.messages).where(eq(schema.messages.id, parentId));
  if (!parent || parent.direction !== "buyer_to_seller") throw new MessageError("unknown message", 404);
  if (!input.text?.trim() && !input.audio) throw new MessageError("reply is empty");

  const { output } = await generateText({
    model: model(),
    system:
      "You translate an Indian artisan's reply for her international buyer. The reply may be spoken audio or text. Translate faithfully; do not add promises, discounts or facts.",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `The buyer had written: "${parent.originalText.slice(0, 500)}"\nNow translate the seller's reply.` },
          ...(input.audio ? [{ type: "file" as const, data: input.audio.data, mediaType: input.audio.mediaType }] : []),
          ...(input.text ? [{ type: "text" as const, text: `Seller's reply: ${input.text.slice(0, MAX_LEN)}` }] : []),
        ],
      },
    ],
    output: Output.object({ schema: ReplySchema, name: "seller_reply" }),
  });
  if (!output) throw new MessageError("could not translate reply", 503);

  const [saved] = await d
    .insert(schema.messages)
    .values({
      storeId: parent.storeId,
      orderId: parent.orderId,
      productId: parent.productId,
      parentId: parent.id,
      direction: "seller_to_buyer",
      channel: input.audio ? "voice" : "web",
      originalText: output.transcript,
      originalLanguage: output.language,
      translatedText: output.english,
      translatedLanguage: "English",
    })
    .returning();
  await d.update(schema.messages).set({ readAt: new Date() }).where(eq(schema.messages.id, parent.id));
  return saved;
}

/** What a buyer (or their agent) may see: no Scam Shield verdicts, replies in English. */
export function toBuyerView(m: typeof schema.messages.$inferSelect) {
  return {
    id: m.id,
    from: m.direction === "buyer_to_seller" ? ("buyer" as const) : ("maker" as const),
    text: m.direction === "buyer_to_seller" ? m.originalText : (m.translatedText ?? m.originalText),
    original: m.direction === "seller_to_buyer" ? { text: m.originalText, language: m.originalLanguage } : null,
    at: m.createdAt.toISOString(),
  };
}

export async function getBuyerThread(q: { orderId?: string; rootId?: string }) {
  const d = await db();
  const where = q.orderId
    ? eq(schema.messages.orderId, q.orderId)
    : q.rootId
      ? or(eq(schema.messages.id, q.rootId), eq(schema.messages.parentId, q.rootId))
      : undefined;
  if (!where) return [];
  const rows = await d.select().from(schema.messages).where(where).orderBy(asc(schema.messages.createdAt));
  return rows.map(toBuyerView);
}

/** Seller inbox: buyer messages newest first, each with its replies and Scam Shield verdict. */
export async function getSellerInbox(storeId: string) {
  const d = await db();
  const rows = await d
    .select({ m: schema.messages, productTitle: schema.products.title, orderStatus: schema.orders.status })
    .from(schema.messages)
    .leftJoin(schema.products, eq(schema.products.id, schema.messages.productId))
    .leftJoin(schema.orders, eq(schema.orders.id, schema.messages.orderId))
    .where(and(eq(schema.messages.storeId, storeId)))
    .orderBy(desc(schema.messages.createdAt));
  const replies = rows.filter((r) => r.m.direction === "seller_to_buyer");
  return rows
    .filter((r) => r.m.direction === "buyer_to_seller")
    .map((r) => ({
      ...r.m,
      createdAt: r.m.createdAt.toISOString(),
      productTitle: r.productTitle,
      orderStatus: r.orderStatus,
      replies: replies
        .filter((x) => x.m.parentId === r.m.id)
        .map((x) => ({ id: x.m.id, text: x.m.originalText, english: x.m.translatedText, at: x.m.createdAt.toISOString() }))
        .reverse(),
    }));
}
