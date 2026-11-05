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

  const captured = { status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP-1B", status: "COMPLETED" }] } }] };
  // Fresh: not reconciled yet. Stale: PayPal says it was captured → paid.
  const fresh = await ag.reconcileIfStale(await agreement(a.id), { lookup: async () => captured });
  assert.equal(fresh?.status, "paying");
  const later = new Date(Date.now() + ag.PAYING_STALE_MS + 1000);
  const settled = await ag.reconcileIfStale(await agreement(a.id), { now: later, lookup: async () => captured });
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

// ── Forced interleavings (follow-up review) ─────────────────────────────────
// Revision/decline pause right after their first read while a capture starts.
// Correct behaviour: the capture waits for them (same lock, same order), then sees
// the changed terms and refuses — PayPal is never called. On PGlite this ordering is
// guaranteed by its single connection; on PostgreSQL it depends on the locks.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function approvedWithOrder() {
  const s = await shop();
  const { r, a } = await proposed(s.id);
  await svc.buyerApprove(r.id, a.id, a.termsHash);
  await svc.sellerApprove(r.id, a.id, a.termsHash);
  const o = await orderFor(s.id, a);
  return { s, r, a, o };
}

test("7. a revision paused after its read and a capture started meanwhile: one consistent winner, PayPal not called", async () => {
  const { s, r, a, o } = await approvedWithOrder();
  let paypalCalled = false;
  let capture: Promise<string> = Promise.resolve("not started");
  const newTerms = { ...(a.terms as import("@/lib/custom/agreement").Terms), unitPriceUsdCents: 2500, totalUsdCents: 2500 };
  const revision = ag
    .proposeAgreement(r.id, s.id, newTerms, {
      afterRead: async () => {
        capture = captureCheckoutOrder(o.paypalOrderId, {
          paypalCall: (async () => {
            paypalCalled = true;
            return completed;
          }) as never,
        }).then(
          () => "captured",
          (e) => `refused: ${(e as Error).message}`,
        );
        await sleep(400);
      },
    })
    .then(
      () => "revised",
      (e) => `refused: ${(e as Error).message}`,
    );
  const rev = await revision;
  const cap = await capture;
  assert.equal(rev, "revised", "the revision that read first completes");
  assert.match(cap, /^refused: .*(replaced|changed)/, "the capture then sees the new terms and refuses");
  assert.equal(paypalCalled, false, "nobody was charged");
  assert.equal((await agreement(a.id)).status, "superseded");
});

test("7b. a decline paused after its read and a capture started meanwhile: capture refused, PayPal not called", async () => {
  const { r, a, o } = await approvedWithOrder();
  let paypalCalled = false;
  let capture: Promise<string> = Promise.resolve("not started");
  const decline = svc
    .declineRequest(r.id, {
      afterRead: async () => {
        capture = captureCheckoutOrder(o.paypalOrderId, {
          paypalCall: (async () => {
            paypalCalled = true;
            return completed;
          }) as never,
        }).then(
          () => "captured",
          (e) => `refused: ${(e as Error).message}`,
        );
        await sleep(400);
      },
    })
    .then(
      () => "declined",
      (e) => `refused: ${(e as Error).message}`,
    );
  assert.equal(await decline, "declined");
  assert.match(await capture, /^refused:/);
  assert.equal(paypalCalled, false);
  assert.equal((await agreement(a.id)).status, "cancelled");
});

test("8. reconciliation records the whole payment, not just the agreement — and downstream work sees it", async () => {
  const { r, a, o } = await approvedWithOrder();
  await ag.beginAgreementCapture(o);
  const later = new Date(Date.now() + ag.PAYING_STALE_MS + 1000);
  const pp = {
    id: o.paypalOrderId,
    status: "COMPLETED",
    payer: { email_address: "ana@example.com", name: { given_name: "Ana", surname: "Lima" } },
    purchase_units: [
      {
        shipping: { name: { full_name: "Ana Lima" }, address: { address_line_1: "1 Main St", admin_area_2: "Austin", admin_area_1: "TX", postal_code: "78701", country_code: "US" } },
        payments: { captures: [{ id: "CAP-RECONCILED", status: "COMPLETED", create_time: "2026-11-05T10:00:00Z", seller_receivable_breakdown: { paypal_fee: { value: "1.08" }, net_amount: { value: "18.92" } } }] },
      },
    ],
  };
  const settled = await ag.reconcileIfStale(await agreement(a.id), { now: later, lookup: async () => pp });
  assert.equal(settled?.status, "paid");
  const [order] = await d.select().from(schema.orders).where(eq(schema.orders.id, o.id));
  assert.equal(order.status, "COMPLETED");
  assert.equal(order.paypalCaptureId, "CAP-RECONCILED");
  assert.equal(order.capturedAt?.toISOString(), "2026-11-05T10:00:00.000Z");
  assert.equal(order.feeCents, 108);
  assert.equal(order.netCents, 1892);
  assert.equal(order.buyerName, "Ana Lima");
  assert.equal(order.shippingAddress?.countryCode, "US");
  assert.equal((await svc.loadRequest(r.id)).status, "paid");

  // Downstream: production → ready to ship (needs a capture id) → refundable capture on record.
  const { getAutopilotBoard } = await import("@/lib/autopilot/refunds");
  await svc.recordProgress(r.id, 1);
  const board = await getAutopilotBoard(order.storeId);
  assert.ok(board.toShip.some((x) => x.id === o.id && x.shipTo === "Austin, US"), "ready to ship with the buyer's address");

  // Idempotent: reconciling / finalising again changes nothing.
  const { finalizePayment } = await import("@/lib/paypal/finalize");
  await finalizePayment(o.id, pp);
  const [again] = await d.select().from(schema.orders).where(eq(schema.orders.id, o.id));
  assert.equal(again.capturedAt?.toISOString(), order.capturedAt?.toISOString());
});

test("9. completion is decided by the capture record: order COMPLETED + capture PENDING is not paid; no capture record is not paid", async () => {
  const later = new Date(Date.now() + ag.PAYING_STALE_MS + 1000);
  for (const pp of [
    { status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP-P", status: "PENDING" }] } }] },
    { status: "COMPLETED", purchase_units: [{}] },
    { status: "COMPLETED" },
  ]) {
    const { a, o } = await approvedWithOrder();
    await ag.beginAgreementCapture(o);
    const settled = await ag.reconcileIfStale(await agreement(a.id), { now: later, lookup: async () => pp });
    assert.equal(settled?.status, "paying", `stays locked for ${JSON.stringify(pp).slice(0, 80)}`);
    const [order] = await d.select().from(schema.orders).where(eq(schema.orders.id, o.id));
    assert.equal(order.capturedAt, null);
    assert.notEqual(order.status, "COMPLETED");
  }
});

test("9b. a PENDING capture from PayPal's capture call waits for the webhook, which then completes it", async () => {
  const { a, o } = await approvedWithOrder();
  const pending = { status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP-PEND", status: "PENDING" }] } }] };
  const res = await captureCheckoutOrder(o.paypalOrderId, { paypalCall: (async () => pending) as never });
  assert.equal(res.status, "PENDING");
  assert.equal((await agreement(a.id)).status, "paying");
  const done = await handleWebhookEvent(
    { id: `WH-${randomUUID()}`, event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-PEND", status: "COMPLETED", create_time: "2026-11-05T11:00:00Z", supplementary_data: { related_ids: { order_id: o.paypalOrderId } } } },
    { database: d },
  );
  assert.equal(done.status, "applied");
  assert.equal((await agreement(a.id)).status, "paid");
  const [order] = await d.select().from(schema.orders).where(eq(schema.orders.id, o.id));
  assert.equal(order.status, "COMPLETED");
  assert.equal(order.capturedAt?.toISOString(), "2026-11-05T11:00:00.000Z");
});
