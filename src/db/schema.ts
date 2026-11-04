import { integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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
  title: text("title").notNull(),
  description: text("description").notNull(),
  priceCents: integer("price_cents").notNull(),
  currency: text("currency").notNull().default("USD"),
  images: jsonb("images").$type<string[]>().notNull().default([]),
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
