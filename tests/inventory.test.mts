import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.PGLITE_DIR = "memory://";
process.env.PAYPAL_CLIENT_ID ??= "test";
process.env.PAYPAL_CLIENT_SECRET ??= "test";
process.env.GOOGLE_API_KEY ??= "test";

const { db, schema } = await import("@/db");
const { eq } = await import("drizzle-orm");
const inv = await import("@/lib/inventory");
const { captureCheckoutOrder, CheckoutError } = await import("@/lib/paypal/orders");
const { handleWebhookEvent } = await import("@/lib/paypal/webhook-handler");

type DB = Awaited<ReturnType<typeof db>>;
let d: DB;
let storeId: string;

before(async () => {
  d = await db();
  const [s] = await d.insert(schema.stores).values({ slug: `inv-${randomUUID()}`, name: "Test", ownerName: "Meera" }).returning();
  storeId = s.id;
});

async function product(quantity = 1) {
  const [p] = await d
    .insert(schema.products)
    .values({ storeId, title: "Dupatta", description: "d", priceCents: 3200, status: "live", quantity })
    .returning();
  return p;
}
async function order(paypalOrderId: string, id = randomUUID()) {
  const [o] = await d
    .insert(schema.orders)
    .values({ id, storeId, paypalOrderId, status: "APPROVED", amountCents: 3200, currency: "USD", items: [] })
    .returning();
  return o;
}
const sold = async (productId: string) => (await d.select().from(schema.products).where(eq(schema.products.id, productId)))[0].soldQuantity;
const past = new Date(Date.now() - 60 * 60_000);

test("two simultaneous buyers: only one can reserve the last piece", async () => {
  const p = await product(1);
  const results = await Promise.allSettled([inv.reserve(p.id, 1, randomUUID()), inv.reserve(p.id, 1, randomUUID())]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.ok(failed.reason instanceof inv.SoldOutError);
});

test("ten agents racing for a batch of three: exactly three succeed", async () => {
  const p = await product(3);
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => inv.reserve(p.id, 1, randomUUID())));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
});

test("approval after the hold expired: re-held if the piece is still free", async () => {
  const p = await product(1);
  const o = randomUUID();
  await inv.reserve(p.id, 1, o, 1, past); // expired long ago
  assert.equal(await inv.ensureReservedForCapture(o), true);
  assert.equal((await inv.availableQuantity(p.id)).available, 0);
});

test("approval after the hold expired and someone else bought it: refused", async () => {
  const p = await product(1);
  const late = randomUUID();
  const other = randomUUID();
  await inv.reserve(p.id, 1, late, 1, past);
  await inv.reserve(p.id, 1, other); // free again because the first hold expired
  await inv.consume(other);
  await assert.rejects(inv.ensureReservedForCapture(late), inv.SoldOutError);
});

test("a sold-out order is never sent to PayPal for capture", async () => {
  const p = await product(1);
  const late = await order("LATEORDER00000001");
  await inv.reserve(p.id, 1, late.id, 1, past);
  const winner = randomUUID();
  await inv.reserve(p.id, 1, winner);
  await inv.consume(winner);

  let calls = 0;
  const paypalCall = (async () => {
    calls++;
    throw new Error("must not be called");
  }) as never;
  await assert.rejects(captureCheckoutOrder("LATEORDER00000001", { paypalCall }), (e: unknown) => e instanceof CheckoutError && e.status === 409);
  assert.equal(calls, 0, "PayPal capture was not attempted");
  assert.equal(await sold(p.id), 1);
});

test("a successful capture counts the sale once", async () => {
  const p = await product(1);
  const o = await order("GOODORDER00000001");
  await inv.reserve(p.id, 1, o.id);
  const paypalCall = (async () => ({
    id: "GOODORDER00000001",
    status: "COMPLETED",
    purchase_units: [{ payments: { captures: [{ id: "CAPTURE0000000001", status: "COMPLETED" }] } }],
  })) as never;
  const r = await captureCheckoutOrder("GOODORDER00000001", { paypalCall });
  assert.equal(r.status, "COMPLETED");
  assert.equal(await sold(p.id), 1);
});

test("duplicate webhooks and an interrupted capture count the sale exactly once", async () => {
  const p = await product(1);
  const o = await order("WEBHOOKORDER00001");
  await inv.reserve(p.id, 1, o.id);
  // PayPal captured, but our own update never ran (crash): the webhook recovers it — twice.
  const event = (id: string) => ({
    id,
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: { id: "CAPTUREWEBHOOK001", status: "COMPLETED", supplementary_data: { related_ids: { order_id: "WEBHOOKORDER00001" } } },
  });
  await handleWebhookEvent(event("WH-INV-1"), { database: d });
  await handleWebhookEvent(event("WH-INV-1"), { database: d }); // exact duplicate delivery
  await handleWebhookEvent(event("WH-INV-2"), { database: d }); // same capture, new event id
  assert.equal(await sold(p.id), 1);
  const [r] = await d.select().from(schema.reservations).where(eq(schema.reservations.orderId, o.id));
  assert.equal(r.status, "consumed");
});

test("availability reflects sold pieces and live holds", async () => {
  const p = await product(2);
  const a = randomUUID();
  await inv.reserve(p.id, 1, a);
  assert.deepEqual(await inv.availableQuantity(p.id), { available: 1, held: 1, sold: 0, total: 2 });
  await inv.consume(a);
  assert.deepEqual(await inv.availableQuantity(p.id), { available: 1, held: 0, sold: 1, total: 2 });
});
