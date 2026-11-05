/**
 * Refund bookkeeping under overlap: the order's refund total and status must be
 * written against the order as it is when PayPal's refund returns — not as it was
 * read before the call (another refund, or PayPal's own refund webhook, may have
 * landed meanwhile).
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.PGLITE_DIR = "memory://";
process.env.PAYPAL_CLIENT_ID ??= "test";
process.env.PAYPAL_CLIENT_SECRET ??= "test";
process.env.GOOGLE_API_KEY ??= "test";

const { db, schema, closeDb } = await import("@/db");
const { eq } = await import("drizzle-orm");
const { executeRefund } = await import("@/lib/autopilot/refunds");
const { handleWebhookEvent } = await import("@/lib/paypal/webhook-handler");

type DB = Awaited<ReturnType<typeof db>>;
let d: DB;
before(async () => {
  d = await db();
});
after(closeDb);

async function paidOrder(amountCents = 3000) {
  const [s] = await d.insert(schema.stores).values({ slug: `rf-${randomUUID()}`, name: "Refunds", ownerName: "Meera" }).returning();
  const paypalOrderId = `RF${randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase()}`;
  const [o] = await d
    .insert(schema.orders)
    .values({ storeId: s.id, paypalOrderId, status: "COMPLETED", amountCents, currency: "USD", items: [], paypalCaptureId: `CAP-${paypalOrderId}`, capturedAt: new Date() })
    .returning();
  return o;
}
async function proposal(o: { id: string; storeId: string; paypalCaptureId: string | null }, amountCents: number) {
  const [a] = await d
    .insert(schema.agentActions)
    .values({
      storeId: o.storeId,
      orderId: o.id,
      agent: "autopilot",
      tool: "create_refund",
      input: { amountCents, currency: "USD", captureId: o.paypalCaptureId, issue: "damaged", reasonEn: "damaged", policyReasons: [] },
      summaryHi: "x",
      status: "proposed",
    })
    .returning();
  return a;
}
const ok = (id: string) => (async () => ({ id, status: "COMPLETED" })) as never;

test("a refund that overlaps another refund and PayPal's refund webhook keeps the full total and never moves the status backwards", async () => {
  const o = await paidOrder(3000);
  const big = await proposal(o, 2000);
  const small = await proposal(o, 1000);

  // While PayPal processes the $20 refund: the $10 refund completes, and PayPal's
  // webhook reports the capture as fully refunded ($30 of $30).
  const result = await executeRefund(big.id, "seller_voice", {
    paypalCall: (async () => {
      await executeRefund(small.id, "seller_voice", { paypalCall: ok("RF-SMALL") });
      await handleWebhookEvent(
        { id: `WH-${randomUUID()}`, event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "RF-BIG", links: [{ rel: "up", href: `https://api/v2/payments/captures/${o.paypalCaptureId}` }] } },
        { database: d, getCapture: async () => ({ id: o.paypalCaptureId!, status: "REFUNDED", supplementary_data: { related_ids: { order_id: o.paypalOrderId } } }) as never },
      );
      return { id: "RF-BIG", status: "COMPLETED" };
    }) as never,
  });
  assert.equal(result.status, "executed");
  const [row] = await d.select().from(schema.orders).where(eq(schema.orders.id, o.id));
  assert.equal(row.refundedCents, 3000, "both refunds are on record ($10 + $20)");
  assert.equal(row.status, "REFUNDED", "not moved back to PARTIALLY_REFUNDED");
});
