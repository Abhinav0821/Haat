import { customType, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/** Binary column. Stored in Postgres so uploads survive redeploys (no local disk). */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** A seller's shop. */
export const stores = pgTable("stores", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  ownerName: text("owner_name").notNull(),
  country: text("country").notNull().default("IN"),
  currency: text("currency").notNull().default("USD"),
  /** Seller rules the autopilot must obey, e.g. { autoRefundMaxCents: 1500 }. */
  policy: jsonb("policy").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
});

export const products = pgTable("products", {
  id: id(),
  storeId: text("store_id").notNull().references(() => stores.id),
  paypalProductId: text("paypal_product_id"),
  /** Client draft id — makes publishing idempotent (double taps, retries). */
  publishKey: text("publish_key").unique(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  priceCents: integer("price_cents").notNull(),
  currency: text("currency").notNull().default("USD"),
  /** media ids */
  images: jsonb("images").$type<string[]>().notNull().default([]),
  /** Seller's original voice note (media id), transcript and language — shown as "Meet the maker". */
  voiceNoteId: text("voice_note_id"),
  sellerTranscript: text("seller_transcript"),
  sellerTranslation: text("seller_translation"),
  sellerLanguage: text("seller_language"),
  attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
  status: text("status", { enum: ["draft", "live", "archived"] }).notNull().default("draft"),
  createdAt: createdAt(),
});

export const orders = pgTable(
  "orders",
  {
    id: id(),
    storeId: text("store_id").notNull().references(() => stores.id),
    paypalOrderId: text("paypal_order_id").notNull(),
    paypalCaptureId: text("paypal_capture_id"),
    /** CREATED → APPROVED → COMPLETED (captured) → REFUNDED / PARTIALLY_REFUNDED */
    status: text("status").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    items: jsonb("items").$type<{ productId: string; qty: number; priceCents: number }[]>().notNull(),
    buyerEmail: text("buyer_email"),
    buyerName: text("buyer_name"),
    /** Shipping address PayPal confirmed for this order — the only address Seller Protection covers. */
    shippingAddress: jsonb("shipping_address").$type<{
      name?: string;
      lines: string[];
      city?: string;
      state?: string;
      postalCode?: string;
      countryCode?: string;
    }>(),
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    refundedCents: integer("refunded_cents").notNull().default(0),
    trackingNumber: text("tracking_number"),
    trackingCarrier: text("tracking_carrier"),
    trackingAddedAt: timestamp("tracking_added_at", { withTimezone: true }),
    /** "storefront" | "mcp" (bought by an AI agent) | "chat" */
    channel: text("channel").notNull().default("storefront"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("orders_paypal_order_id_idx").on(t.paypalOrderId)],
);

/**
 * Every action an agent proposes or takes. Doubles as the approval inbox
 * (status = "proposed") and the audit log.
 */
export const agentActions = pgTable("agent_actions", {
  id: id(),
  storeId: text("store_id").notNull().references(() => stores.id),
  agent: text("agent").notNull(), // "autopilot" | "concierge" | "catalog"
  orderId: text("order_id").references(() => orders.id),
  messageId: text("message_id"),
  /** What the agent proposes, in the seller's language and in English. */
  summaryHi: text("summary_hi"),
  summaryEn: text("summary_en"),
  tool: text("tool").notNull(),
  input: jsonb("input").notNull(),
  reasoning: text("reasoning"),
  status: text("status", {
    enum: ["proposed", "approved", "rejected", "executed", "failed", "blocked"],
  }).notNull(),
  result: jsonb("result"),
  createdAt: createdAt(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
});

/** PayPal webhook events, keyed by PayPal's event id for idempotent processing. */
export const webhookEvents = pgTable("webhook_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  receivedAt: createdAt(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
});

/** Uploaded photos and voice notes. */
export const media = pgTable("media", {
  id: id(),
  storeId: text("store_id").notNull().references(() => stores.id),
  kind: text("kind", { enum: ["image", "audio"] }).notNull(),
  mediaType: text("media_type").notNull(),
  bytes: bytea("bytes").notNull(),
  createdAt: createdAt(),
});

/** Buyer ↔ seller messages, stored in both languages, with the Scam Shield verdict. */
export const messages = pgTable("messages", {
  id: id(),
  storeId: text("store_id").notNull().references(() => stores.id),
  orderId: text("order_id").references(() => orders.id),
  productId: text("product_id").references(() => products.id),
  /** Reply threading: seller replies point at the buyer message they answer. */
  parentId: text("parent_id"),
  direction: text("direction", { enum: ["buyer_to_seller", "seller_to_buyer"] }).notNull(),
  /** "web" | "mcp" (sent by a buyer's AI agent) | "voice" (seller spoke the reply) */
  channel: text("channel").notNull().default("web"),
  buyerEmail: text("buyer_email"),
  originalText: text("original_text").notNull(),
  originalLanguage: text("original_language"),
  translatedText: text("translated_text"),
  translatedLanguage: text("translated_language"),
  /** Scam Shield verdict for buyer messages. */
  shield: jsonb("shield").$type<{
    level: "safe" | "caution" | "danger";
    flags: { code: string; hi: string; en: string }[];
    checkedAgainstPayPal: boolean;
  }>(),
  /** What the buyer wants (from the AI read), e.g. "refund_or_problem". */
  intent: text("intent"),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: createdAt(),
});
