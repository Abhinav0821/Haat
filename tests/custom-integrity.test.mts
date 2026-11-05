/**
 * Regression tests for the agreement-integrity review (one test per finding).
 * Each scenario was first reproduced against the previous code; these assert the fix.
 * Runs on embedded PGlite by default; with DATABASE_URL on real PostgreSQL, where the
 * concurrency cases are meaningful.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.PGLITE_DIR = "memory://";
process.env.PAYPAL_CLIENT_ID ??= "test";
process.env.PAYPAL_CLIENT_SECRET ??= "test";
process.env.GOOGLE_API_KEY ??= "test";
process.env.INR_PER_USD = "100";

const { db, schema, closeDb } = await import("@/db");
const { eq } = await import("drizzle-orm");
const svc = await import("@/lib/custom/requests");
const ag = await import("@/lib/custom/agreement");
const inv = await import("@/lib/inventory");
const { captureCheckoutOrder } = await import("@/lib/paypal/orders");
const { handleWebhookEvent } = await import("@/lib/paypal/webhook-handler");

type DB = Awaited<ReturnType<typeof db>>;
let d: DB;
before(async () => {
  d = await db();
});
after(closeDb);

// Simple rules: no costs, ₹1,000 minimum, one piece a week, 1 courier day, ₹100 = $1.
const RULES = { materialsInr: 0, packagingInr: 0, otherInr: 0, shippingCostInr: 0, shippingChargeUsdCents: 0, minimumInr: 1000, piecesPerWeek: 1, backlogPieces: 0, shippingDays: 1, askBeforeChanges: true, feePercent: 0, feeFixedUsdCents: 0 };

async function shop(e: Record<string, unknown> = RULES) {
  const [s] = await d.insert(schema.stores).values({ slug: `int-${randomUUID()}`, name: "Integrity", ownerName: "Maker", policy: { economics: e } }).returning();
  return s;
}

async function proposed(storeId: string, options = [{ quantity: 1, usd: 20 }, { quantity: 1, usd: 25 }]) {
  const r = await svc.createCustomRequest(storeId, { buyerText: "Please make one red cotton scarf", channel: "web" }, {
    hear: async () => ({ quantity: 1, item: "scarf", itemHi: "दुपट्टा", colors: ["red"], colorsHi: ["लाल"], materials: ["cotton"], materialsHi: ["सूती"], deadline: null, budget: null, otherWishes: "Exactly 2 metres long.", otherWishesHi: "ठीक 2 मीटर लंबा।" }),
  });
  await svc.draftAnswer(r.id, { text: "x" }, {
    hear: async () => ({
      transcript: "x",
      decline: false,
      options: options.map((o) => ({ quantity: o.quantity, price: { amount: o.usd, currency: "USD" as const, basis: "per_piece" as const }, completionBy: null, colors: null, materials: null, note: "Dry clean only.", noteHi: "सिर्फ़ ड्राई क्लीन।" })),
    }),
  });
  await svc.sendOptions(r.id, options.map((_, i) => i));
  const a = await svc.chooseOption(r.id, { kind: "option", index: 0 });
  return { r, a };
}

const pid = () => `IT${randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase()}`;
async function orderFor(storeId: string, a: { id: string; termsHash: string; terms: unknown }) {
  const [o] = await d
    .insert(schema.orders)
    .values({ storeId, paypalOrderId: pid(), status: "APPROVED", amountCents: (a.terms as { totalUsdCents: number }).totalUsdCents, currency: "USD", items: [], channel: "custom", agreementId: a.id, termsHash: a.termsHash })
    .returning();
  return o;
}
const completed = { status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP-IT", status: "COMPLETED" }] } }] };
const agreement = async (id: string) => (await d.select().from(schema.agreements).where(eq(schema.agreements.id, id)))[0];

test("1. terms cannot be revised while their payment is being captured; the capture stays with the version it charged", async () => {
  const s = await shop();
  const { r, a } = await proposed(s.id);
  await svc.buyerApprove(r.id, a.id, a.termsHash);
  await svc.sellerApprove(r.id, a.id, a.termsHash);
  const o = await orderFor(s.id, a);

  let revisionError: unknown = null;
  let declineError: unknown = null;
  const res = await captureCheckoutOrder(o.paypalOrderId, {
    paypalCall: (async () => {
      // While PayPal is capturing: try to switch to the $25 option, and to decline.
      revisionError = await svc.chooseOption(r.id, { kind: "option", index: 1 }).then(() => null, (e) => e);
      declineError = await svc.declineRequest(r.id).then(() => null, (e) => e);
      return completed;
    }) as never,
  });
  assert.equal(res.status, "COMPLETED");
  assert.match(String((revisionError as Error)?.message), /being processed/);
  assert.match(String((declineError as Error)?.message), /being processed/);
  const charged = await agreement(a.id);
  assert.equal(charged.status, "paid");
  assert.equal(charged.orderId, o.id);
  const versions = await d.select().from(schema.agreements).where(eq(schema.agreements.requestId, r.id));
  assert.equal(versions.length, 1, "no newer version was created");
  assert.equal((await svc.loadRequest(r.id)).status, "paid");
});

test("1b. a definite decline releases the lock; an unknown outcome is reconciled with PayPal", async () => {
  const s = await shop();
  const { r, a } = await proposed(s.id);
  await svc.buyerApprove(r.id, a.id, a.termsHash);
  await svc.sellerApprove(r.id, a.id, a.termsHash);
  const o = await orderFor(s.id, a);

  const { PayPalApiError } = await import("@/lib/paypal/client");
  const declined = (async () => {
    throw new PayPalApiError(422, { details: [{ issue: "INSTRUMENT_DECLINED" }] } as never, "declined");
  }) as never;
  await assert.rejects(captureCheckoutOrder(o.paypalOrderId, { paypalCall: declined }), /declined/);
  assert.equal((await agreement(a.id)).status, "approved", "no money moved: back to approved");

  const timeout = (async () => {
    throw new Error("socket hang up");
  }) as never;
  await assert.rejects(captureCheckoutOrder(o.paypalOrderId, { paypalCall: timeout }));
  assert.equal((await agreement(a.id)).status, "paying", "unknown outcome: stays locked");
  await assert.rejects(svc.chooseOption(r.id, { kind: "option", index: 1 }), /being processed/);

  // Fresh: not reconciled yet. Stale: PayPal says it was captured → paid.
  const fresh = await ag.reconcileIfStale(await agreement(a.id), { lookup: async () => ({ status: "COMPLETED" }) });
  assert.equal(fresh?.status, "paying");
  const later = new Date(Date.now() + ag.PAYING_STALE_MS + 1000);
  const settled = await ag.reconcileIfStale(await agreement(a.id), { now: later, lookup: async () => ({ status: "COMPLETED" }) });
  assert.equal(settled?.status, "paid");
});

test("1c. a stale payment PayPal never captured goes back to approved", async () => {
  const s = await shop();
  const { r, a } = await proposed(s.id);
  await svc.buyerApprove(r.id, a.id, a.termsHash);
  await svc.sellerApprove(r.id, a.id, a.termsHash);
  const o = await orderFor(s.id, a);
  await ag.beginAgreementCapture(o);
  const later = new Date(Date.now() + ag.PAYING_STALE_MS + 1000);
  const settled = await ag.reconcileIfStale(await agreement(a.id), { now: later, lookup: async () => ({ status: "APPROVED" }) });
  assert.equal(settled?.status, "approved");
});

test("2. capacity is re-checked atomically when terms become fully approved — whoever approves last", async () => {
  const s = await shop(); // 1 piece per week
  const first = await proposed(s.id);
  const second = await proposed(s.id);
  // The maker approves both first; each passes on its own.
  await svc.sellerApprove(first.r.id, first.a.id, first.a.termsHash);
  await svc.sellerApprove(second.r.id, second.a.id, second.a.termsHash);
  // Buyers approve: the first books the week; the second no longer fits.
  await svc.buyerApprove(first.r.id, first.a.id, first.a.termsHash);
  await assert.rejects(svc.buyerApprove(second.r.id, second.a.id, second.a.termsHash), /no longer fit/);
  const stillOpen = await agreement(second.a.id);
  assert.equal(stillOpen.status, "proposed");
  assert.equal(stillOpen.sellerApprovedHash, null, "her approval is cleared so she revises the terms");
  assert.equal(await ag.effectiveBacklog(s.id, RULES as never), 1, "only one piece booked");
});

test("2b. two final approvals at the same moment cannot both book the same week", async () => {
  const s = await shop();
  const x = await proposed(s.id);
  const y = await proposed(s.id);
  await svc.sellerApprove(x.r.id, x.a.id, x.a.termsHash);
  await svc.sellerApprove(y.r.id, y.a.id, y.a.termsHash);
  const results = await Promise.allSettled([svc.buyerApprove(x.r.id, x.a.id, x.a.termsHash), svc.buyerApprove(y.r.id, y.a.id, y.a.termsHash)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(await ag.effectiveBacklog(s.id, RULES as never), 1);
});

test("3. earnings are checked on the agreement's own payment, with her current costs", async () => {
  const s = await shop();
  const { r, a } = await proposed(s.id);
  await svc.buyerApprove(r.id, a.id, a.termsHash);
  // Her rules change after the quote: materials ₹2,000 and a $20 shipping charge for NEW quotes.
  await d.update(schema.stores).set({ policy: { economics: { ...RULES, materialsInr: 2000, shippingChargeUsdCents: 2000 } } }).where(eq(schema.stores.id, s.id));
  // The agreement still charges $20 total with $0 shipping → leaves nothing for her work.
  await assert.rejects(svc.sellerApprove(r.id, a.id, a.termsHash), /loss|below|minimum/i);
  assert.equal((await agreement(a.id)).status, "proposed");
});

test("4. a transient capture failure is retried when PayPal redelivers the webhook", async () => {
  const s = await shop();
  const [o] = await d.insert(schema.orders).values({ storeId: s.id, paypalOrderId: pid(), status: "CREATED", amountCents: 2000, currency: "USD", items: [], channel: "mcp" }).returning();
  const event = { id: `WH-${randomUUID()}`, event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: o.paypalOrderId } };
  let calls = 0;
  const capture = async () => {
    calls++;
    if (calls === 1) throw new Error("simulated transient capture failure");
    return { orderId: o.id, status: "COMPLETED" };
  };
  await assert.rejects(handleWebhookEvent(event, { database: d, capture }), /transient/, "first delivery fails → PayPal will redeliver");
  const retry = await handleWebhookEvent(event, { database: d, capture });
  assert.equal(calls, 2, "the redelivery tried the capture again");
  assert.deepEqual(retry, { status: "applied", orderId: o.id, orderStatus: "COMPLETED" });
});

test("5. both readings carry every clause: buyer requirements, her condition, handmade variation, refunds", async () => {
  const s = await shop();
  const { a } = await proposed(s.id);
  const t = a.terms as import("@/lib/custom/agreement").Terms;
  assert.deepEqual(t.requirements, [{ en: "Exactly 2 metres long.", hi: "ठीक 2 मीटर लंबा।" }], "the requirement is part of the hashed terms");
  const en = ag.termsLinesEn(t).map(([k, v]) => `${k}: ${v}`).join("\n");
  const hi = ag.termsHi(t, 100);
  assert.match(en, /2 metres/);
  assert.match(en, /Dry clean only/);
  assert.match(en, /printed by hand/);
  assert.match(en, /no returns for change of mind/);
  assert.match(hi, /ठीक 2 मीटर/);
  assert.match(hi, /सिर्फ़ ड्राई क्लीन/);
  assert.match(hi, /हाथ से छपता है/);
  assert.match(hi, /मन बदलने पर वापसी नहीं/);
  assert.match(hi, /दुपट्टा, लाल, सूती/, "her item and colour words");
  // Changing the requirement changes the hash: both approve it.
  assert.notEqual(ag.hashTerms({ ...t, requirements: [{ en: "Exactly 3 metres long.", hi: null }] }), a.termsHash);
});

test("6. concurrent sale confirmations count stock once", async () => {
  const s = await shop();
  const [p] = await d.insert(schema.products).values({ storeId: s.id, title: "Dupatta", description: "d", priceCents: 3200, status: "live", quantity: 3 }).returning();
  const orderId = randomUUID();
  await inv.reserve(p.id, 2, orderId);
  let results: boolean[];
  if (process.env.DATABASE_URL) {
    // Real Postgres: force the race. Hold the product lock while three confirmations
    // start, so each reads the reservation before any of them can finish.
    const { sql } = await import("drizzle-orm");
    let pending: Promise<boolean[]> = Promise.resolve([]);
    await d.transaction(async (tx) => {
      await tx.execute(sql`select id from products where id = ${p.id} for update`);
      pending = Promise.all([inv.consume(orderId), inv.consume(orderId), inv.consume(orderId)]);
      await new Promise((r) => setTimeout(r, 400));
    });
    results = await pending;
  } else {
    results = await Promise.all([inv.consume(orderId), inv.consume(orderId), inv.consume(orderId)]);
  }
  assert.equal(results.filter(Boolean).length, 1, "exactly one caller counts the sale");
  const [after] = await d.select().from(schema.products).where(eq(schema.products.id, p.id));
  assert.equal(after.soldQuantity, 2);
});
