import { customType, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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
  /** Pieces made (handmade work is often one of a kind → 1). */
  quantity: integer("quantity").notNull().default(1),
  soldQuantity: integer("sold_quantity").notNull().default(0),
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
    /** Shipping charged to the buyer (part of amountCents). */
    shippingCents: integer("shipping_cents").notNull().default(0),
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
    /** From PayPal's seller_receivable_breakdown at capture: exact fee and what the seller receives. */
    feeCents: integer("fee_cents"),
    netCents: integer("net_cents"),
    trackingNumber: text("tracking_number"),
    trackingCarrier: text("tracking_carrier"),
    trackingAddedAt: timestamp("tracking_added_at", { withTimezone: true }),
    /** Set when the order pays for a custom-order agreement: the exact terms paid for. */
    agreementId: text("agreement_id"),
    termsHash: text("terms_hash"),
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
  /** 64-bit difference hash (hex) for images — finds re-used photos even after re-encoding. */
  dhash: text("dhash"),
  sha256: text("sha256"),
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
  /** Buyer photos (payment screenshots, damage photos) with what AI saw in them. */
  attachments: jsonb("attachments").$type<
    {
      mediaId: string;
      dhash: string | null;
      kind: "payment_screenshot" | "product_damage" | "product_other" | "other" | "unanalysed";
      summary?: string;
      payment?: { amount: number | null; currency: string | null; transactionId: string | null; date: string | null; recipient: string | null };
      damage?: { description: string; severity: "none" | "minor" | "major"; sameProductAsListing: "yes" | "no" | "unsure" };
    }[]
  >(),
  /** What the buyer wants (from the AI read), e.g. "refund_or_problem". */
  intent: text("intent"),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/**
 * Maker Evidence: signed record that the maker had the piece in hand recently
 * (live photo with a handwritten code), that it isn't a mass-market item,
 * and that its photos aren't reused.
 */
export const passports = pgTable("passports", {
  id: id(),
  productId: text("product_id")
    .notNull()
    .unique()
    .references(() => products.id),
  storeId: text("store_id").notNull().references(() => stores.id),
  /** e.g. "कमल 4821" — written on paper and photographed next to the piece. */
  code: text("code").notNull(),
  codeIssuedAt: timestamp("code_issued_at", { withTimezone: true }).notNull(),
  proofMediaId: text("proof_media_id"),
  status: text("status", { enum: ["awaiting_photo", "verified", "needs_review", "rejected"] }).notNull(),
  checks: jsonb("checks").$type<Record<string, unknown>>(),
  /** Ed25519 signature (base64url) over the canonical passport payload. */
  signature: text("signature"),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/**
 * Stock held for an order while the buyer approves payment on PayPal.
 * Created under a row lock on the product; every capture path re-checks it.
 * "active" past expiresAt counts as expired (no sweeper needed).
 */
export const reservations = pgTable("reservations", {
  id: id(),
  productId: text("product_id").notNull().references(() => products.id),
  orderId: text("order_id").notNull().unique(),
  qty: integer("qty").notNull(),
  status: text("status", { enum: ["active", "consumed", "released"] }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

/** Lightweight usage events for the pilot study (timings, corrections). No personal data. */
export const events = pgTable("events", {
  id: id(),
  storeId: text("store_id"),
  name: text("name").notNull(),
  props: jsonb("props").$type<Record<string, unknown>>().notNull().default({}),
  at: createdAt(),
});

/** A buyer (or their AI agent) asking for something that doesn't exist yet. */
export const customRequests = pgTable("custom_requests", {
  id: id(),
  storeId: text("store_id").notNull().references(() => stores.id),
  channel: text("channel").notNull().default("web"), // "web" | "mcp"
  buyerName: text("buyer_name"),
  buyerEmail: text("buyer_email"),
  buyerText: text("buyer_text").notNull(),
  /** Structured request (quantity, item, colours, materials, deadline, budget). */
  spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
  summaryHi: text("summary_hi"),
  sellerSaid: text("seller_said"),
  /** Options the maker drafted by voice, each with code-checked verdicts (not yet visible to the buyer). */
  draftOptions: jsonb("draft_options").$type<unknown[]>(),
  /** Options the maker approved and sent. */
  options: jsonb("options").$type<unknown[]>(),
  /** Last buyer counter-offer and Haat's deterministic answer. */
  counter: jsonb("counter").$type<Record<string, unknown>>(),
  status: text("status", { enum: ["new", "options_sent", "agreement", "paid", "declined"] }).notNull().default("new"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Immutable, versioned order terms. Approvals are bound to the terms hash;
 * a change creates a new version and invalidates earlier approvals. Payment is
 * only possible against the current version with both approvals.
 */
export const agreements = pgTable("agreements", {
  id: id(),
  storeId: text("store_id").notNull().references(() => stores.id),
  requestId: text("request_id").notNull().references(() => customRequests.id),
  version: integer("version").notNull(),
  supersededById: text("superseded_by_id"),
  terms: jsonb("terms").$type<Record<string, unknown>>().notNull(),
  termsHash: text("terms_hash").notNull(),
  status: text("status", { enum: ["proposed", "approved", "superseded", "paid", "expired", "cancelled"] }).notNull(),
  buyerApprovedHash: text("buyer_approved_hash"),
  buyerApprovedAt: timestamp("buyer_approved_at", { withTimezone: true }),
  sellerApprovedHash: text("seller_approved_hash"),
  sellerApprovedAt: timestamp("seller_approved_at", { withTimezone: true }),
  /** Capacity is held from approval until this time if unpaid. */
  holdUntil: timestamp("hold_until", { withTimezone: true }),
  orderId: text("order_id"),
  createdAt: createdAt(),
});

/** Rate-limit hits, shared by every server instance (serverless-safe). */
export const rateHits = pgTable(
  "rate_hits",
  {
    id: id(),
    key: text("key").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("rate_hits_key_at").on(t.key, t.at)],
);
