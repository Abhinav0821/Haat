import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";
process.env.PAYPAL_CLIENT_ID = "test";
process.env.PAYPAL_CLIENT_SECRET = "test";
process.env.GOOGLE_API_KEY = "test";
const { db, schema, closeDb } = await import("@/db");
const { eq } = await import("drizzle-orm");
const ag = await import("@/lib/custom/agreement");
const inv = await import("@/lib/inventory");
const { captureCheckoutOrder } = await import("@/lib/paypal/orders");
const { PayPalApiError } = await import("@/lib/paypal/client");
const originalFetch = globalThis.fetch;
const ids = new Map<string, string>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  if (url.endsWith("/v1/oauth2/token")) return json({ access_token: "test", expires_in: 3600 });
  if (url.endsWith("/v2/checkout/orders")) {
    const key = new Headers(init?.headers).get("PayPal-Request-Id")!;
    if (!ids.has(key)) ids.set(key, `PPRETRY${String(ids.size + 1).padStart(10, "0")}`);
    return json({ id: ids.get(key), links: [] });
  }
  throw new Error(`Unexpected network request: ${url}`);
}) as typeof fetch;
before(async () => { await db(); });
after(async () => { globalThis.fetch = originalFetch; await closeDb(); });
const refusal = (async () => { throw new PayPalApiError(422, { details: [{ issue: "COMPLIANCE_VIOLATION" }] }, "capture"); }) as never;

async function store() {
  return (await (await db()).insert(schema.stores).values({ slug: `refusal-${randomUUID()}`, name: "Test", ownerName: "Maker" }).returning())[0];
}

test("custom checkout replaces a refused payment and concurrent retries share one new PayPal order", async () => {
  const d = await db(), s = await store();
  const [request] = await d.insert(schema.customRequests).values({ storeId: s.id, buyerText: "one scarf", spec: { quantity: 1 } }).returning();
  const terms: import("@/lib/custom/agreement").Terms = { v: 1, shop: s.name, maker: s.ownerName, item: "scarf", quantity: 1, unitPriceUsdCents: 2000, shippingUsdCents: 0, totalUsdCents: 2000, colors: [], materials: [], completionBy: "2027-01-01", deliveryEstimate: "2027-01-10", handmadeVariation: "handmade", refundTerms: "refund", note: null };
  const hash = ag.hashTerms(terms);
  const [a] = await d.insert(schema.agreements).values({ storeId: s.id, requestId: request.id, version: 1, terms, termsHash: hash, status: "approved", buyerApprovedHash: hash, sellerApprovedHash: hash, holdUntil: new Date(Date.now() + 24 * 3600_000) }).returning();
  const ctx = { appUrl: "https://haat.test", storeSlug: s.slug };
  const first = await ag.createAgreementCheckout(a.id, ctx);
  await assert.rejects(captureCheckoutOrder(first.paypalOrderId, { paypalCall: refusal }), /not been charged/);
  const retries = await Promise.all([ag.createAgreementCheckout(a.id, ctx), ag.createAgreementCheckout(a.id, ctx)]);
  assert.notEqual(retries[0].paypalOrderId, first.paypalOrderId);
  assert.equal(retries[0].paypalOrderId, retries[1].paypalOrderId);
  assert.equal((await d.select().from(schema.orders).where(eq(schema.orders.agreementId, a.id))).length, 2);
  const done = await captureCheckoutOrder(retries[0].paypalOrderId, { paypalCall: (async () => ({ status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP-RETRY", status: "COMPLETED" }] } }] })) as never });
  assert.equal(done.status, "COMPLETED");
  assert.equal((await d.select().from(schema.agreements).where(eq(schema.agreements.id, a.id)))[0].status, "paid");
});

test("a terminal storefront refusal releases its stock immediately", async () => {
  const d = await db(), s = await store();
  const [p] = await d.insert(schema.products).values({ storeId: s.id, title: "Scarf", description: "Scarf", priceCents: 2000, status: "live", quantity: 1 }).returning();
  const [o] = await d.insert(schema.orders).values({ storeId: s.id, paypalOrderId: "PPSTOCKREFUSAL01", status: "APPROVED", amountCents: 2000, currency: "USD", items: [{ productId: p.id, qty: 1, priceCents: 2000 }], channel: "storefront" }).returning();
  await inv.reserve(p.id, 1, o.id);
  await assert.rejects(captureCheckoutOrder(o.paypalOrderId, { paypalCall: refusal }), /not been charged/);
  assert.deepEqual(await inv.availableQuantity(p.id), { available: 1, held: 0, sold: 0, total: 1 });
  let called = false;
  await assert.rejects(captureCheckoutOrder(o.paypalOrderId, { paypalCall: (async () => { called = true; }) as never }), /start the payment again/);
  assert.equal(called, false);
});
