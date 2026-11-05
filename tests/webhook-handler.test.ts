import { before, test } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import type * as DbModule from "@/db";
import type * as HandlerModule from "@/lib/paypal/webhook-handler";

// Must be set before "@/db" is first loaded, hence the dynamic imports in before().
process.env.PGLITE_DIR = "memory://";

let schema: typeof DbModule.schema;
let handleWebhookEvent: typeof HandlerModule.handleWebhookEvent;
let shouldAdvance: typeof HandlerModule.shouldAdvance;
let database: DB;
let seq = 0;

async function seedOrder(paypalOrderId: string, status = "CREATED", channel = "storefront") {
  const [store] = await database
    .insert(schema.stores)
    .values({ slug: `store-${++seq}`, name: "Test", ownerName: "Meera" })
    .returning();
  const [order] = await database
    .insert(schema.orders)
    .values({ storeId: store.id, paypalOrderId, status, amountCents: 4200, currency: "USD", items: [], channel })
    .returning();
  return order;
}

const statusOf = async (id: string) =>
  (await database.select().from(schema.orders).where(eq(schema.orders.id, id)))[0];

const captureEvent = (id: string, orderId: string, type = "PAYMENT.CAPTURE.COMPLETED") => ({
  id,
  event_type: type,
  resource: { id: `CAP-${orderId}`, status: "COMPLETED", supplementary_data: { related_ids: { order_id: orderId } } },
});

before(async () => {
  const dbModule = await import("@/db");
  ({ handleWebhookEvent, shouldAdvance } = await import("@/lib/paypal/webhook-handler"));
  schema = dbModule.schema;
  database = await dbModule.db();
});

test("CHECKOUT.ORDER.APPROVED moves CREATED → APPROVED", async () => {
  const o = await seedOrder("ORD-A");
  const r = await handleWebhookEvent(
    { id: "WH-A", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "ORD-A" } },
    { database },
  );
  assert.equal(r.status, "applied");
  assert.equal((await statusOf(o.id)).status, "APPROVED");
});

test("PAYMENT.CAPTURE.COMPLETED finds the order via supplementary_data and stores the capture id", async () => {
  const o = await seedOrder("ORD-B", "APPROVED");
  await handleWebhookEvent(captureEvent("WH-B", "ORD-B"), { database });
  const row = await statusOf(o.id);
  assert.equal(row.status, "COMPLETED");
  assert.equal(row.paypalCaptureId, "CAP-ORD-B");
});

test("a redelivered event is acknowledged but not re-applied", async () => {
  await seedOrder("ORD-C", "APPROVED");
  const first = await handleWebhookEvent(captureEvent("WH-C", "ORD-C"), { database });
  const second = await handleWebhookEvent(captureEvent("WH-C", "ORD-C"), { database });
  assert.equal(first.status, "applied");
  assert.deepEqual(second, { status: "duplicate" });
});

test("out-of-order delivery never moves an order backwards", async () => {
  const o = await seedOrder("ORD-D", "COMPLETED");
  const r = await handleWebhookEvent(
    { id: "WH-D", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "ORD-D" } },
    { database },
  );
  assert.equal(r.status, "recorded");
  assert.equal((await statusOf(o.id)).status, "COMPLETED");
});

test("PAYMENT.CAPTURE.REFUNDED reads the capture to tell partial from full refunds", async () => {
  const o = await seedOrder("ORD-E", "COMPLETED");
  const refundEvent = (id: string) => ({
    id,
    event_type: "PAYMENT.CAPTURE.REFUNDED",
    resource: {
      id: `REF-${id}`,
      links: [{ rel: "up", href: "https://api.sandbox.paypal.com/v2/payments/captures/CAP-E" }],
    },
  });
  const capture = (status: string) => async (captureId: string) => {
    assert.equal(captureId, "CAP-E");
    return { id: captureId, status, supplementary_data: { related_ids: { order_id: "ORD-E" } } };
  };

  await handleWebhookEvent(refundEvent("WH-E1"), { database, getCapture: capture("PARTIALLY_REFUNDED") });
  assert.equal((await statusOf(o.id)).status, "PARTIALLY_REFUNDED");

  await handleWebhookEvent(refundEvent("WH-E2"), { database, getCapture: capture("REFUNDED") });
  assert.equal((await statusOf(o.id)).status, "REFUNDED");
});

test("events for unknown orders and non-order events are recorded, not errors", async () => {
  const unknown = await handleWebhookEvent(captureEvent("WH-F", "ORD-NOPE"), { database });
  assert.equal(unknown.status, "recorded");

  const dispute = await handleWebhookEvent(
    { id: "WH-G", event_type: "CUSTOMER.DISPUTE.CREATED", resource: { dispute_id: "PP-D-1" } },
    { database },
  );
  assert.equal(dispute.status, "recorded");
  const [stored] = await database.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.id, "WH-G"));
  assert.ok(stored?.processedAt, "dispute event is stored for the autopilot");
});

test("status ranking", () => {
  assert.equal(shouldAdvance("CREATED", "COMPLETED"), true);
  assert.equal(shouldAdvance("REFUNDED", "COMPLETED"), false);
  assert.equal(shouldAdvance("PARTIALLY_REFUNDED", "PARTIALLY_REFUNDED"), true);
  assert.equal(shouldAdvance("COMPLETED", "COMPLETED"), false);
});

test("agent (MCP) orders are captured when the approval webhook arrives", async () => {
  await seedOrder("ORD-MCP", "CREATED", "mcp");
  const captured: string[] = [];
  const r = await handleWebhookEvent(
    { id: "WH-MCP", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "ORD-MCP" } },
    { database, capture: async (id) => (captured.push(id), { orderId: "x", status: "COMPLETED" }) },
  );
  assert.deepEqual(captured, ["ORD-MCP"]);
  assert.equal(r.status === "applied" && r.orderStatus, "COMPLETED");
});

test("storefront orders are not auto-captured by the webhook (the browser captures them)", async () => {
  await seedOrder("ORD-WEB", "CREATED", "storefront");
  let called = false;
  await handleWebhookEvent(
    { id: "WH-WEB", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "ORD-WEB" } },
    { database, capture: async () => ((called = true), { orderId: "x", status: "COMPLETED" }) },
  );
  assert.equal(called, false);
});
