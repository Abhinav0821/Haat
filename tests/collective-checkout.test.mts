import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = process.env.COLLECTIVE_TEST_DATABASE_URL ?? "";
process.env.PAYPAL_CLIENT_ID = "test";
process.env.PAYPAL_CLIENT_SECRET = "test";
process.env.GOOGLE_API_KEY = "test";
process.env.INR_PER_USD = "88";

const { db, schema, closeDb } = await import("@/db");
const { eq } = await import("drizzle-orm");
const svc = await import("@/lib/collective/service");
const co = await import("@/lib/collective/checkout");
const pay = await import("@/lib/collective/payouts");
const { seedCollective, DEMO_MEMBERS, newMemberLink } = await import("@/lib/collective/seed");
const { buyerView, makerView, internalView } = await import("@/lib/collective/views");
const { captureCheckoutOrder, CheckoutError } = await import("@/lib/paypal/orders");
const { finalizePayment } = await import("@/lib/paypal/finalize");
const { handleWebhookEvent } = await import("@/lib/paypal/webhook-handler");
const { PayPalApiError } = await import("@/lib/paypal/client");
const { CollectiveError, offerPlan, respondToPart, buyerApprove, createOrder, activeReservations, currentPlan, updateMemberFacts, updateOrderRequirements } = svc;

const NOW = new Date("2026-11-07T09:00:00Z");
const later = (h: number) => new Date(NOW.getTime() + h * 3600_000);
type Seeded = Awaited<ReturnType<typeof seedCollective>>;
let n = 0;
let s: Seeded;
const tokenOf = (name: string) => s.members.find((m) => m.name === name)!.token;
const idOf = (name: string) => s.members.find((m) => m.name === name)!.id;
const nameOf = (id: string) => s.members.find((m) => m.id === id)!.name;

// ── PayPal stand-in: order creation with PayPal-Request-Id idempotency ──
const created: { requestId: string | null; body: Record<string, unknown> }[] = [];
const byRequestId = new Map<string, string>();
let seq = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
  if (url.endsWith("/v1/oauth2/token")) return json({ access_token: "t", expires_in: 3600 });
  if (url.endsWith("/v2/checkout/orders") && init?.method === "POST") {
    const rid = new Headers(init.headers).get("PayPal-Request-Id");
    created.push({ requestId: rid, body: JSON.parse(String(init.body)) });
    const id = (rid && byRequestId.get(rid)) ?? `PPCOLL${String(++seq).padStart(10, "0")}`;
    if (rid) byRequestId.set(rid, id);
    return json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: `https://sandbox.paypal.test/checkoutnow?token=${id}` }] });
  }
  throw new Error(`unexpected fetch in test: ${url}`);
}) as typeof fetch;

before(async () => {
  await db();
});
after(async () => {
  globalThis.fetch = realFetch;
  await closeDb();
});

beforeEach(async () => {
  const d = await db();
  s = await seedCollective(d, { slug: `pay-${process.pid}-${++n}`, at: later(-24) });
  for (const m of DEMO_MEMBERS) await updateMemberFacts(idOf(m.name), m.facts, { source: "maker_confirmed", name: m.name }, later(-1));
});

const order = (quantity = 60, deadline = "2026-11-30") =>
  createOrder(s.collective.id, { buyerText: `${quantity} scarves`, buyerName: "Test Buyer", spec: { quantity, deadline, budgetUsdCents: null, details: "indigo", detailsHi: "नीला रंग" } });

async function partsOf(planId: string) {
  const d = await db();
  const [p] = await d.select().from(schema.collectivePlans).where(eq(schema.collectivePlans.id, planId));
  const refs = (p.terms as { parts: { memberId: string; partId: string; termsHash: string }[] }).parts;
  const rows = await d.select().from(schema.memberParts);
  return refs.map((r) => ({ ...r, row: rows.find((x) => x.id === r.partId)!, name: nameOf(r.memberId) }));
}
async function acceptAll(planId: string, at = NOW) {
  for (const p of await partsOf(planId)) if (p.row.status === "pending") await respondToPart(tokenOf(p.name), p.partId, p.termsHash, "accept", null, at);
}
async function approved(quantity = 60) {
  const o = await order(quantity);
  const plan = await offerPlan(o.id, "primary", NOW);
  await acceptAll(plan.id);
  const a = await buyerApprove(plan.id, plan.termsHash, NOW);
  return { o, plan: a };
}
const planRow = async (id: string) => (await (await db()).select().from(schema.collectivePlans).where(eq(schema.collectivePlans.id, id)))[0];
const orderRow = async (id: string) => (await (await db()).select().from(schema.collectiveOrders).where(eq(schema.collectiveOrders.id, id)))[0];
const paymentRow = async (paypalOrderId: string) => (await (await db()).select().from(schema.orders).where(eq(schema.orders.paypalOrderId, paypalOrderId)))[0];
const shares = async (planId: string) => (await db()).select().from(schema.makerShares).where(eq(schema.makerShares.planId, planId));
const checkout = (o: { id: string }, plan: { id: string; termsHash: string }, at = NOW) => co.createCollectiveCheckout(o.id, plan.id, plan.termsHash, { appUrl: "https://haat.test" }, at);
const completed = (id = "CAP-COLL-1") => ({ status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id, status: "COMPLETED", seller_receivable_breakdown: { paypal_fee: { value: "19.63" }, net_amount: { value: "419.66" } } }] } }] });
const okCapture = (async () => completed()) as never;
const never = () => {
  const spy = { called: false, fn: (async () => { spy.called = true; return completed(); }) as never };
  return spy;
};
const rejectsC = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: unknown) => e instanceof CollectiveError && re.test(e.message));
const rejectsCheckout = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: unknown) => e instanceof CheckoutError && e.status === 409 && re.test(e.message) && /not been charged/.test(e.message));

test("payment opens only for the approved, held, fully accepted current plan; the PayPal order is bound to its exact terms", async () => {
  const o = await order();
  const plan = await offerPlan(o.id, "primary", NOW);
  await rejectsC(checkout(o, plan), /Not every maker/);
  await acceptAll(plan.id);
  await rejectsC(checkout(o, plan), /approve the terms first/);
  await buyerApprove(plan.id, plan.termsHash, NOW);
  await rejectsC(co.createCollectiveCheckout(o.id, plan.id, "0".repeat(64), { appUrl: "x" }, NOW), /terms changed/);

  const before = created.length;
  const c = await checkout(o, plan);
  const total = (plan.terms as { buyer: { totalUsdCents: number } }).buyer.totalUsdCents;
  assert.equal(c.totalUsdCents, total);
  assert.match(c.approveUrl!, /paypal/);
  const body = created[created.length - 1].body as { purchase_units: { custom_id: string; amount: { value: string }; items: { unit_amount: { value: string } }[] }[]; payment_source: { paypal: { experience_context: { brand_name: string; return_url: string } } } };
  assert.equal(body.purchase_units[0].custom_id, plan.id);
  assert.equal(body.purchase_units[0].amount.value, (total / 100).toFixed(2), "amount from the frozen terms");
  assert.equal(body.purchase_units[0].items[0].unit_amount.value, (total / 100).toFixed(2), "items sum to the amount");
  assert.equal(body.payment_source.paypal.experience_context.brand_name, s.collective.name, "the collective is the seller");
  const row = await paymentRow(c.paypalOrderId);
  assert.equal(row.collectivePlanId, plan.id);
  assert.equal(row.termsHash, plan.termsHash);
  assert.equal(row.storeId, null, "not any maker's shop");
  assert.equal(row.amountCents, total);

  const again = await checkout(o, plan);
  assert.equal(again.paypalOrderId, c.paypalOrderId, "same plan and hash → the same PayPal order");
  assert.equal(created.length, before + 2);
  assert.equal(created[created.length - 1].requestId, created[created.length - 2].requestId);
  assert.equal((await (await db()).select().from(schema.orders).where(eq(schema.orders.collectivePlanId, plan.id))).length, 1);
});

test("capture marks the exact plan paid and creates each maker's share once, from her accepted part", async () => {
  const { o, plan } = await approved();
  const c = await checkout(o, plan);
  const res = await captureCheckoutOrder(c.paypalOrderId, { paypalCall: okCapture, now: later(1) });
  assert.equal(res.status, "COMPLETED");
  const p = await planRow(plan.id);
  assert.equal(p.status, "paid");
  assert.equal(p.paymentRef, (await paymentRow(c.paypalOrderId)).id);
  assert.equal((await orderRow(o.id)).status, "paid");
  const row = await paymentRow(c.paypalOrderId);
  assert.equal(row.feeCents, 1963, "PayPal's own fee is recorded");
  assert.equal(row.netCents, 41966);

  const ss = await shares(plan.id);
  const parts = await partsOf(plan.id);
  assert.equal(ss.length, parts.length);
  for (const part of parts) {
    const sh = ss.find((x) => x.memberId === part.memberId)!;
    assert.equal(sh.partId, part.partId);
    assert.equal(sh.partTermsHash, part.termsHash);
    assert.equal(sh.owedPaise, Math.round((part.row.terms as { payInr: number }).payInr * 100));
  }
  const money = (p.plan as { money: { makersInr: number } }).money;
  assert.equal(ss.reduce((t, x) => t + x.owedPaise, 0), Math.round(money.makersInr * 100), "shares add up to the makers' pay in the plan");

  // Idempotent: a retried capture and a replayed finalisation change nothing.
  assert.equal((await captureCheckoutOrder(c.paypalOrderId, { paypalCall: okCapture, now: later(1) })).status, "COMPLETED");
  await finalizePayment(row.id, completed(), later(2));
  assert.equal((await shares(plan.id)).length, parts.length);

  // Paid capacity stays reserved, with no expiry.
  const held = await activeReservations(await db(), s.collective.id, later(24 * 30));
  assert.equal(held.flatMap((r) => r.production).reduce((t, x) => t + x.pieces, 0), 60);

  // Buyer sees paid, nothing about makers' money; each maker sees "start" and only her share.
  const bv = await buyerView(o.id, later(2));
  assert.equal(bv.offer?.status, "paid");
  assert.ok(bv.offer?.paidAt);
  assert.doesNotMatch(JSON.stringify(bv), /Meera|Sunita|Rukhsana|₹|Paise|owed|reference|fee/i);
  for (const part of parts) {
    const mv = await makerView(tokenOf(part.name), later(2));
    const mine = mv.parts.find((x) => x.id === part.partId)!;
    assert.equal(mine.paid, true);
    assert.equal(mine.share?.owedPaise, ss.find((x) => x.memberId === part.memberId)!.owedPaise);
    for (const other of parts.filter((x) => x.name !== part.name)) assert.doesNotMatch(JSON.stringify(mv), new RegExp(other.name));
  }
});

test("while a payment is being captured nothing can change: no re-plan, no withdrawal, no fact or requirement edits; after payment the plan is frozen", async () => {
  const { o, plan } = await approved();
  const c = await checkout(o, plan);
  const [first] = await partsOf(plan.id);
  const errors: Record<string, unknown> = {};
  await captureCheckoutOrder(c.paypalOrderId, {
    now: later(1),
    paypalCall: (async () => {
      errors.replan = await offerPlan(o.id, "primary", later(1)).then(() => null, (e) => e);
      errors.decline = await respondToPart(tokenOf(first.name), first.partId, first.termsHash, "decline", null, later(1)).then(() => null, (e) => e);
      const facts = DEMO_MEMBERS.find((m) => m.name === first.name)!.facts;
      errors.facts = await updateMemberFacts(first.memberId, { ...facts, askInr: facts.askInr + 25 }, { source: "maker_confirmed", name: first.name }, later(1)).then(() => null, (e) => e);
      errors.requirements = await updateOrderRequirements(o.id, "indigo, 2 m", "नीला रंग, 2 मीटर", later(1)).then(() => null, (e) => e);
      errors.second = await co.beginCollectiveCapture({ id: "other-order", collectivePlanId: plan.id, termsHash: plan.termsHash, amountCents: (await paymentRow(c.paypalOrderId)).amountCents }, later(1)).then(() => null, (e) => e);
      return completed();
    }) as never,
  });
  assert.match(String((errors.replan as Error)?.message), /being processed/);
  assert.match(String((errors.decline as Error)?.message), /being processed/);
  assert.match(String((errors.facts as Error)?.message), /payment involving this maker/);
  assert.match(String((errors.requirements as Error)?.message), /during or after payment/);
  assert.match(String((errors.second as Error)?.message), /Another payment/);
  assert.equal((await planRow(plan.id)).status, "paid");
  assert.equal((await (await db()).select().from(schema.collectivePlans).where(eq(schema.collectivePlans.orderId, o.id))).length, 1, "no newer version was created");

  await rejectsC(offerPlan(o.id, "primary", later(2)), /already paid/);
  await rejectsC(respondToPart(tokenOf(first.name), first.partId, first.termsHash, "decline", null, later(2)), /paid/);
  await rejectsC(checkout(o, plan, later(2)), /already paid/);
});

test("capture is refused — and PayPal never asked — when a maker withdrew, the hold lapsed, or the order doesn't match the terms", async () => {
  // A maker says no after the buyer opened PayPal.
  {
    const { o, plan } = await approved();
    const c = await checkout(o, plan);
    const [p0] = await partsOf(plan.id);
    await respondToPart(tokenOf(p0.name), p0.partId, p0.termsHash, "decline", "fell ill", later(1));
    const spy = never();
    await rejectsCheckout(captureCheckoutOrder(c.paypalOrderId, { paypalCall: spy.fn, now: later(1) }), /revised/);
    assert.equal(spy.called, false);
    assert.equal((await planRow(plan.id)).status, "maker_declined");
  }
  // The hold lapsed before the buyer finished on PayPal: released, never charged.
  {
    const { o, plan } = await approved(20);
    const c = await checkout(o, plan);
    const spy = never();
    const late = new Date(plan.holdUntil!.getTime() + 60_000);
    await rejectsCheckout(captureCheckoutOrder(c.paypalOrderId, { paypalCall: spy.fn, now: late }), /approve/);
    assert.equal(spy.called, false);
    // (The refusal rolls back its own transaction; an expired hold is never counted, and the next read lapses it.)
    assert.equal((await activeReservations(await db(), s.collective.id, late)).length, 0, "capacity released");
    assert.equal((await currentPlan(await db(), o.id, late))!.status, "ready", "the buyer approves again, which re-checks");
    assert.equal((await activeReservations(await db(), s.collective.id, late)).length, 0, "capacity released");
  }
  // An order row that doesn't match the plan's hash or amount.
  {
    const { o, plan } = await approved(20);
    const c = await checkout(o, plan);
    const row = await paymentRow(c.paypalOrderId);
    await rejectsC(co.beginCollectiveCapture({ ...row, termsHash: "f".repeat(64) }, later(1)), /changed after checkout/);
    await rejectsC(co.beginCollectiveCapture({ ...row, amountCents: row.amountCents - 1 }, later(1)), /amount/);
    assert.equal((await planRow(plan.id)).status, "approved");
  }
});

test("an unpaid hold ends when the first work day starts, so makers never start unpaid work", async () => {
  const { plan } = await approved();
  const p = plan.plan as { production: { day: number }[]; finishing: { day: number }[] };
  const start = (plan.facts as { startDate: string }).startDate;
  const first = svc.firstWorkDate(plan.plan as never, start);
  assert.ok(plan.holdUntil!.getTime() <= svc.dayBegins(first));
  assert.ok(plan.holdUntil!.getTime() <= NOW.getTime() + svc.HOLD_MS);
  assert.ok(p.production.length > 0);
  // Late on the eve of the first work day, approval holds only until midnight in India.
  const eve = new Date(svc.dayBegins(first) - 30 * 60_000);
  assert.equal(svc.holdEnd(plan.plan as never, start, eve).getTime(), svc.dayBegins(first));
});

test("a definite refusal returns the plan to approved; an unknown outcome stays paying and is reconciled from PayPal's record", async () => {
  const { o, plan } = await approved();
  const c = await checkout(o, plan);
  const declined = (async () => {
    throw new PayPalApiError(422, { details: [{ issue: "INSTRUMENT_DECLINED" }] } as never, "declined");
  }) as never;
  await assert.rejects(captureCheckoutOrder(c.paypalOrderId, { paypalCall: declined, now: later(1) }), /declined/);
  assert.equal((await planRow(plan.id)).status, "approved");
  assert.equal((await orderRow(o.id)).status, "approved");

  const timeout = (async () => {
    throw new Error("socket hang up");
  }) as never;
  await assert.rejects(captureCheckoutOrder(c.paypalOrderId, { paypalCall: timeout, now: later(1) }));
  const paying = await planRow(plan.id);
  assert.equal(paying.status, "paying", "unknown outcome: stays locked");
  assert.equal(await co.reconcileCollectiveIfStale(paying, { now: later(1.05), lookup: async () => { throw new Error("should not look yet"); } }), paying, "not stale yet");

  // PayPal says it was never captured → back to approved.
  const back = await co.reconcileCollectiveIfStale(paying, { now: new Date(later(1).getTime() + co.PAYING_STALE_MS + 1000), lookup: async () => ({ status: "APPROVED" }) });
  assert.equal(back!.status, "approved");

  // Try again; this time PayPal's record shows the capture completed.
  await assert.rejects(captureCheckoutOrder(c.paypalOrderId, { paypalCall: timeout, now: later(1.2) }));
  const again = await planRow(plan.id);
  const done = await co.reconcileCollectiveIfStale(again, { now: new Date(later(1.2).getTime() + co.PAYING_STALE_MS + 1000), lookup: async () => completed() });
  assert.equal(done!.status, "paid");
  assert.equal((await shares(plan.id)).length, (await partsOf(plan.id)).length);
});

test("webhooks: an approved PayPal order is captured through the same checks; a capture webhook completes a paying plan", async () => {
  const { o, plan } = await approved();
  const c = await checkout(o, plan);
  let captured: string | null = null;
  await handleWebhookEvent(
    { id: `WH-A-${n}`, event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: c.paypalOrderId } },
    { capture: async (id) => ((captured = id), { orderId: "x", status: "APPROVED" }) },
  );
  assert.equal(captured, c.paypalOrderId, "the webhook captures collective orders the buyer approved");

  const timeout = (async () => {
    throw new Error("socket hang up");
  }) as never;
  await assert.rejects(captureCheckoutOrder(c.paypalOrderId, { paypalCall: timeout, now: later(1) }));
  assert.equal((await planRow(plan.id)).status, "paying");
  await handleWebhookEvent({
    id: `WH-C-${n}`,
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: { id: "CAP-WH", status: "COMPLETED", supplementary_data: { related_ids: { order_id: c.paypalOrderId } } },
  });
  assert.equal((await planRow(plan.id)).status, "paid");
  assert.equal((await planRow(plan.id)).statusNote, null, "a normal payment carries no review note");
  assert.equal((await shares(plan.id)).length, (await partsOf(plan.id)).length);
});

test("a second capture for terms already paid is never absorbed: the first payment stands and the plan is flagged for a refund", async () => {
  const { o, plan } = await approved(20);
  const c = await checkout(o, plan);
  await captureCheckoutOrder(c.paypalOrderId, { paypalCall: okCapture, now: later(1) });
  const first = await planRow(plan.id);
  const d = await db();
  const [dup] = await d
    .insert(schema.orders)
    .values({ storeId: null, paypalOrderId: "PPDUPLICATE000001", status: "APPROVED", amountCents: (await paymentRow(c.paypalOrderId)).amountCents, currency: "USD", items: [], channel: "collective", collectivePlanId: plan.id, termsHash: plan.termsHash })
    .returning();
  const spy = never();
  await rejectsCheckout(captureCheckoutOrder(dup.paypalOrderId, { paypalCall: spy.fn, now: later(2) }), /already paid/);
  assert.equal(spy.called, false, "our own paths refuse a second capture");
  // If PayPal reports one anyway (e.g. captured outside Haat), it is flagged, not counted.
  await finalizePayment(dup.id, completed("CAP-DUP"), later(2));
  const p = await planRow(plan.id);
  assert.equal(p.paymentRef, first.paymentRef);
  assert.match(p.statusNote ?? "", /second payment.*refund/i);
  assert.equal((await shares(plan.id)).length, (await partsOf(plan.id)).length);
});

test("maker payouts: owed, reported with a reference, and confirmed only by her on her own link", async () => {
  const { o, plan } = await approved();
  const c = await checkout(o, plan);
  await captureCheckoutOrder(c.paypalOrderId, { paypalCall: okCapture, now: later(1) });
  const [a, b] = await partsOf(plan.id);
  const ss = await shares(plan.id);
  const shareA = ss.find((x) => x.memberId === a.memberId)!;
  const shareB = ss.find((x) => x.memberId === b.memberId)!;
  const by = { name: "Kavita" };
  const half = shareA.owedPaise / 200; // rupees

  await assert.rejects(pay.reportMakerPayment(shareA.id, { amountInr: half, method: "upi", reference: "12345" }, by, later(2)), /12-digit/);
  await assert.rejects(pay.reportMakerPayment(shareA.id, { amountInr: 0, method: "upi", reference: "123456789012" }, by, later(2)), /above zero/);
  await assert.rejects(pay.reportMakerPayment(shareA.id, { amountInr: 10.005, method: "upi", reference: "123456789012" }, by, later(2)), /two decimal/);
  await assert.rejects(pay.reportMakerPayment(shareA.id, { amountInr: shareA.owedPaise / 100 + 1, method: "upi", reference: "123456789012" }, by, later(2)), /more than is left/);

  const p1 = await pay.reportMakerPayment(shareA.id, { amountInr: half, method: "upi", reference: "1234 5678 9012" }, by, later(2));
  assert.equal(p1.reference, "123456789012");
  await assert.rejects(pay.reportMakerPayment(shareB.id, { amountInr: 100, method: "upi", reference: "123456789012" }, by, later(2)), /already recorded/, "a reference is used once per collective");

  let sum = (await pay.shareSummaries(await db(), { planId: plan.id })).find((x) => x.shareId === shareA.id)!;
  assert.equal(sum.awaitingPaise, shareA.owedPaise / 2);
  assert.equal(sum.confirmedPaise, 0, "reported is not paid");
  assert.equal(sum.settled, false);

  // Only she can answer, only on her link.
  await rejectsC(pay.respondToPayment(tokenOf(b.name), p1.id, "confirm", null, later(3)), /wasn't found/);
  await pay.respondToPayment(tokenOf(a.name), p1.id, "confirm", null, later(3));
  await rejectsC(pay.respondToPayment(tokenOf(a.name), p1.id, "dispute", null, later(3)), /already confirmed/);
  await rejectsC(pay.withdrawMakerPayment(p1.id), /can't be withdrawn/);

  // The second half: disputed (doesn't count, blocks the room until withdrawn), then she finds it and confirms.
  const p2 = await pay.reportMakerPayment(shareA.id, { amountInr: half, method: "bank", reference: "hdfcr52026110700001" }, by, later(4));
  await pay.respondToPayment(tokenOf(a.name), p2.id, "dispute", "not in my account yet", later(5));
  sum = (await pay.shareSummaries(await db(), { planId: plan.id })).find((x) => x.shareId === shareA.id)!;
  assert.equal(sum.disputedPaise, shareA.owedPaise / 2);
  assert.equal(sum.leftPaise, 0);
  assert.equal(sum.settled, false);
  await assert.rejects(pay.reportMakerPayment(shareA.id, { amountInr: 1, method: "upi", reference: "999999999999" }, by, later(5)), /already reported/);
  await pay.respondToPayment(tokenOf(a.name), p2.id, "confirm", null, later(6));
  sum = (await pay.shareSummaries(await db(), { planId: plan.id })).find((x) => x.shareId === shareA.id)!;
  assert.equal(sum.confirmedPaise, shareA.owedPaise);
  assert.equal(sum.settled, true);

  // A mistaken record is withdrawn; its reference and amount become free again.
  const p3 = await pay.reportMakerPayment(shareB.id, { amountInr: 100, method: "upi", reference: "555555555555" }, by, later(7));
  await pay.withdrawMakerPayment(p3.id);
  await rejectsC(pay.respondToPayment(tokenOf(b.name), p3.id, "confirm", null, later(7)), /withdrew/);
  await pay.reportMakerPayment(shareB.id, { amountInr: shareB.owedPaise / 100, method: "upi", reference: "555555555555" }, by, later(7));

  // A revoked link can no longer answer.
  const [p4] = (await pay.shareSummaries(await db(), { planId: plan.id })).find((x) => x.shareId === shareB.id)!.payments.filter((x) => x.status === "reported");
  await newMemberLink(await db(), b.memberId);
  await rejectsC(pay.respondToPayment(tokenOf(b.name), p4.id, "confirm", null, later(8)), /isn't valid/);

  // Her page shows her share and its payments; the coordinator sees every share.
  const iv = await internalView(o.id, later(8));
  assert.equal(iv.plan?.shares.length, ss.length);
  assert.equal(iv.plan?.payment?.feeCents, 1963);
  const mv = await makerView(tokenOf(a.name), later(8));
  assert.equal(mv.parts.find((x) => x.id === a.partId)!.share?.settled, true);
});

test("days are India's calendar: just after midnight IST, today is already under way and plans start tomorrow", () => {
  // 2026-11-07 00:30 IST is still 2026-11-06 in UTC.
  const justAfterMidnightIST = new Date("2026-11-06T19:00:00Z");
  assert.equal(svc.planStart(justAfterMidnightIST), "2026-11-08");
  assert.equal(svc.planStart(new Date("2026-11-06T18:00:00Z")), "2026-11-07", "23:30 IST on Nov 6: tomorrow is Nov 7");
  assert.equal(new Date(svc.dayBegins("2026-11-09")).toISOString(), "2026-11-08T18:30:00.000Z");
});

test("payouts exist only for paid plans", async () => {
  const { plan } = await approved(20);
  assert.equal((await shares(plan.id)).length, 0, "approval alone owes nobody anything");
  const lapsed = await currentPlan(await db(), plan.orderId, new Date(plan.holdUntil!.getTime() + 1));
  assert.equal(lapsed?.status, "ready");
  assert.equal((await shares(plan.id)).length, 0);
});

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

test("a stale negative lookup cannot unlock a newer capture of the same payment", async () => {
  const { o, plan } = await approved(25);
  const c = await checkout(o, plan);
  const row = await paymentRow(c.paypalOrderId);
  await co.beginCollectiveCapture(row, NOW);
  const stale = await planRow(plan.id);
  const entered = gate(), resume = gate();
  const recovery = co.reconcileCollectiveIfStale(stale, { now: later(0.2), lookup: async () => { entered.open(); await resume.promise; return { status: "APPROVED" }; } });
  await entered.promise;
  await co.reconcileCollectiveIfStale(stale, { now: later(0.2), lookup: async () => ({ status: "APPROVED" }) });
  const capturing = gate(), finish = gate();
  const flight = captureCheckoutOrder(c.paypalOrderId, { now: later(0.25), paypalCall: (async () => { capturing.open(); await finish.promise; return completed(); }) as never });
  await capturing.promise;
  const [part] = await partsOf(plan.id);
  try {
    resume.open(); await recovery;
    assert.equal((await planRow(plan.id)).status, "paying");
    await rejectsC(respondToPart(tokenOf(part.name), part.partId, part.termsHash, "decline", null, later(0.25)), /being processed/);
  } finally { finish.open(); await flight; }
  assert.equal((await planRow(plan.id)).status, "paid");
  assert.equal((await planRow(plan.id)).statusNote, null);
});

test("simultaneous capture callers send only one PayPal capture", async () => {
  const { o, plan } = await approved(25);
  const c = await checkout(o, plan);
  const entered = gate(), finish = gate();
  let calls = 0;
  const call = (async () => { calls++; entered.open(); await finish.promise; return completed(); }) as never;
  const first = captureCheckoutOrder(c.paypalOrderId, { now: NOW, paypalCall: call });
  await entered.promise;
  try {
    const second = await captureCheckoutOrder(c.paypalOrderId, { now: NOW, paypalCall: (async () => { calls++; return completed(); }) as never });
    assert.equal(second.status, "PENDING");
    assert.equal(calls, 1);
    assert.equal((await planRow(plan.id)).status, "paying");
  } finally { finish.open(); await first; }
});

test("a completed retry replaces DENIED and late failure data cannot overwrite its capture", async () => {
  const { o, plan } = await approved(25);
  const c = await checkout(o, plan);
  const denied = { purchase_units: [{ payments: { captures: [{ id: "CAP-DECLINED", status: "DECLINED", seller_receivable_breakdown: { paypal_fee: { value: "0.00" }, net_amount: { value: "0.00" } } }] } }] };
  await captureCheckoutOrder(c.paypalOrderId, { now: NOW, paypalCall: (async () => denied) as never });
  assert.equal((await paymentRow(c.paypalOrderId)).status, "DENIED");
  assert.equal((await planRow(plan.id)).status, "approved");
  await captureCheckoutOrder(c.paypalOrderId, { now: later(0.1), paypalCall: okCapture });
  let row = await paymentRow(c.paypalOrderId);
  assert.equal(row.status, "COMPLETED");
  assert.equal((await planRow(plan.id)).status, "paid");
  await finalizePayment(row.id, denied, later(0.2));
  row = await paymentRow(c.paypalOrderId);
  assert.equal(row.status, "COMPLETED");
  assert.equal(row.paypalCaptureId, "CAP-COLL-1");
  assert.equal(row.feeCents, 1963);
  assert.equal(row.netCents, 41966);
  assert.equal((await planRow(plan.id)).status, "paid");
});

test("a payout reference cannot be reused by changing UPI to bank", async () => {
  const { o, plan } = await approved(25);
  const c = await checkout(o, plan);
  await captureCheckoutOrder(c.paypalOrderId, { now: NOW, paypalCall: okCapture });
  const [share] = await shares(plan.id);
  await pay.reportMakerPayment(share.id, { amountInr: 1, method: "upi", reference: "123456789012" }, { name: "Coordinator" }, NOW);
  await rejectsC(pay.reportMakerPayment(share.id, { amountInr: 1, method: "bank", reference: "1234-5678 9012" }, { name: "Coordinator" }, NOW), /already recorded/);
});

test("legacy material delays use the statement's India date and explicit dates stay fixed", async () => {
  const { MemberFactsSchema, materialsReadyOn, buildFacts } = await import("@/lib/collective/facts");
  const { demoSettings } = await import("@/lib/collective/seed");
  const prov = { source: "maker_confirmed", at: "2026-11-06T19:00:00Z" };
  const f = MemberFactsSchema.parse({ ...DEMO_MEMBERS[1].facts, materialsDays: 3, prov });
  assert.equal(materialsReadyOn(f), "2026-11-10");
  assert.equal(materialsReadyOn({ ...f, materialsReadyDate: "2026-11-09" }), "2026-11-09");
  const facts = buildFacts(demoSettings(prov.at), [{ id: "maker", name: "Sunita", facts: f }], [], "2026-11-08");
  assert.equal(facts.makers[0].materialsReadyDay?.value, 2);
});

test("retrying an uncertain payment refreshes the attempt even without an intermediate unlock", async () => {
  const { o, plan } = await approved(25);
  const c = await checkout(o, plan);
  const timeout = (async () => { throw new Error("lost capture response"); }) as never;
  await assert.rejects(captureCheckoutOrder(c.paypalOrderId, { now: NOW, paypalCall: timeout }));
  const stale = await planRow(plan.id);
  const entered = gate(), resume = gate();
  const recovery = co.reconcileCollectiveIfStale(stale, { now: later(0.2), lookup: async () => { entered.open(); await resume.promise; return { status: "APPROVED" }; } });
  await entered.promise;
  const retrying = gate(), finish = gate();
  const flight = captureCheckoutOrder(c.paypalOrderId, { now: later(0.25), paypalCall: (async (_path: string, request: { signal?: AbortSignal }) => {
    assert.ok(request.signal, "collective captures have a bounded HTTP deadline");
    retrying.open(); await finish.promise; return completed();
  }) as never });
  await retrying.promise;
  try {
    const next = await planRow(plan.id);
    assert.notEqual(next.captureAttemptId, stale.captureAttemptId);
    assert.equal(next.payingSince?.getTime(), later(0.25).getTime());
    resume.open(); await recovery;
    assert.equal((await planRow(plan.id)).status, "paying");
  } finally { finish.open(); await flight; }
});

test("an older attempt cannot clear a newer attempt's lease or unlock its unknown outcome", async () => {
  const { o, plan } = await approved(25);
  const c = await checkout(o, plan);
  const row = await paymentRow(c.paypalOrderId);
  const a = await co.beginCollectiveCapture(row, NOW);
  assert.equal(a.kind, "started");
  if (a.kind !== "started") assert.fail("missing first attempt");
  await co.finishCollectiveCaptureAttempt(row, a.fence);
  const b = await co.beginCollectiveCapture(row, NOW); // even identical timestamps get different ids
  if (b.kind !== "started") assert.fail("missing retry attempt");
  assert.notEqual(b.fence.attemptId, a.fence.attemptId);
  await co.finishCollectiveCaptureAttempt(row, a.fence);
  assert.ok((await planRow(plan.id)).captureLeaseUntil);
  await co.endCollectiveCapture(row, NOW, a.fence);
  assert.equal((await planRow(plan.id)).status, "paying");
  await co.finishCollectiveCaptureAttempt(row, b.fence);
  await co.endCollectiveCapture(row, NOW, a.fence);
  assert.equal((await planRow(plan.id)).status, "paying");
  await co.endCollectiveCapture(row, NOW, b.fence);
  assert.equal((await planRow(plan.id)).status, "approved");
});

test("a negative webhook cannot unlock an active call; authoritative reconciliation can settle a denial", async () => {
  const { o, plan } = await approved(25);
  const c = await checkout(o, plan);
  const entered = gate(), finish = gate();
  const timeout = captureCheckoutOrder(c.paypalOrderId, { now: NOW, paypalCall: (async () => { entered.open(); await finish.promise; throw new Error("connection lost"); }) as never });
  const failed = assert.rejects(timeout, /connection lost/);
  await entered.promise;
  try {
    await handleWebhookEvent({ id: `WH-DENIED-${n}`, event_type: "PAYMENT.CAPTURE.DENIED", resource: { id: "CAP-DENIED", status: "DECLINED", supplementary_data: { related_ids: { order_id: c.paypalOrderId } } } });
    assert.equal((await planRow(plan.id)).status, "paying");
  } finally { finish.open(); await failed; }
  const paying = await planRow(plan.id);
  const settled = await co.reconcileCollectiveIfStale(paying, { now: later(0.2), lookup: async () => ({ purchase_units: [{ payments: { captures: [{ id: "CAP-DENIED", status: "DECLINED" }] } }] }) });
  assert.equal(settled?.status, "approved", "already-recorded DENIED still releases the fenced collective attempt");
});

test("a stale failure response cannot unlock a retry after its lease is released", async () => {
  const { o, plan } = await approved(25);
  const c = await checkout(o, plan);
  const row = await paymentRow(c.paypalOrderId);
  const a = await co.beginCollectiveCapture(row, NOW);
  if (a.kind !== "started") assert.fail("missing first attempt");
  await co.finishCollectiveCaptureAttempt(row, a.fence);
  const b = await co.beginCollectiveCapture(row, later(0.1));
  if (b.kind !== "started") assert.fail("missing second attempt");
  await co.finishCollectiveCaptureAttempt(row, b.fence);
  await finalizePayment(row.id, { purchase_units: [{ payments: { captures: [{ id: "OLD-DECLINE", status: "DECLINED" }] } }] }, later(0.1), { collectiveCaptureFence: a.fence });
  assert.equal((await planRow(plan.id)).status, "paying");
  assert.equal((await planRow(plan.id)).captureAttemptId, b.fence.attemptId);
});

test("order history with a failed capture before a completed retry resolves as paid", async () => {
  const { o, plan } = await approved(25);
  const c = await checkout(o, plan);
  const timeout = (async () => { throw new Error("lost response"); }) as never;
  await assert.rejects(captureCheckoutOrder(c.paypalOrderId, { now: NOW, paypalCall: timeout }));
  const snapshot: Parameters<typeof finalizePayment>[1] = completed();
  snapshot.purchase_units![0].payments!.captures!.unshift({ id: "EARLIER-DECLINE", status: "DECLINED" });
  const p = await co.reconcileCollectiveIfStale(await planRow(plan.id), { now: later(0.2), lookup: async () => snapshot });
  assert.equal(p?.status, "paid");
  assert.equal((await paymentRow(c.paypalOrderId)).status, "COMPLETED");
  assert.equal((await paymentRow(c.paypalOrderId)).paypalCaptureId, "CAP-COLL-1");
});

test("concurrent cross-method reports of the same normalised reference accept only one", async () => {
  const { o, plan } = await approved(25);
  const c = await checkout(o, plan);
  await captureCheckoutOrder(c.paypalOrderId, { now: NOW, paypalCall: okCapture });
  const [share] = await shares(plan.id);
  const results = await Promise.allSettled(["upi", "bank"].map((method) => pay.reportMakerPayment(share.id, { amountInr: 1, method, reference: "1234-5678 9012" }, { name: "Coordinator" }, NOW)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const refused = results.find((r) => r.status === "rejected");
  assert.ok(refused?.status === "rejected" && /already recorded/.test(String(refused.reason)));
});

test("legacy paying records with no attempt id recover without unlocking a newer attempt", async () => {
  const { o, plan } = await approved(25);
  const c = await checkout(o, plan);
  const row = await paymentRow(c.paypalOrderId);
  await (await db()).update(schema.collectivePlans).set({ status: "paying", paymentRef: row.id, payingSince: NOW, captureAttemptId: null, captureLeaseUntil: null }).where(eq(schema.collectivePlans.id, plan.id));
  const legacy = await planRow(plan.id);
  const entered = gate(), resume = gate();
  const recovery = co.reconcileCollectiveIfStale(legacy, { now: later(0.2), lookup: async () => { entered.open(); await resume.promise; return { status: "APPROVED" }; } });
  await entered.promise;
  const newer = await co.beginCollectiveCapture(row, later(0.25));
  assert.equal(newer.kind, "started");
  resume.open(); await recovery;
  assert.equal((await planRow(plan.id)).status, "paying");
  assert.ok((await planRow(plan.id)).captureAttemptId);
});

test("even its own attempt's negative result cannot unlock a plan while that attempt's capture call is in flight", async () => {
  const { o, plan } = await approved(20);
  const c = await checkout(o, plan);
  const row = await paymentRow(c.paypalOrderId);
  const start = await co.beginCollectiveCapture(row, later(1));
  assert.equal(start.kind, "started");
  const fence = (start as { fence: { attemptId: string | null; payingSince: Date | null } }).fence;
  await co.endCollectiveCapture(row, new Date(later(1).getTime() + 30_000), fence);
  assert.equal((await planRow(plan.id)).status, "paying", "lease still active: stays locked");
  await co.endCollectiveCapture(row, new Date(later(1).getTime() + co.CAPTURE_LEASE_MS + 1000), fence);
  assert.equal((await planRow(plan.id)).status, "approved", "after the lease, the same attempt's definite refusal unlocks it");
});

test("PayPal refusing the capture (422 COMPLIANCE_VIOLATION): nothing charged, terms unlocked, the order retired, and the next payment is a NEW PayPal order", async () => {
  const { o, plan } = await approved();
  const first = await checkout(o, plan);
  const refusal = new PayPalApiError(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "COMPLIANCE_VIOLATION" }], debug_id: "dbg1" } as never, `/v2/checkout/orders/${first.paypalOrderId}/capture`);
  assert.match(refusal.message, /COMPLIANCE_VIOLATION/, "the reason is in the logged message");
  assert.match(refusal.message, /dbg1/);
  const refuse = (async () => { throw refusal; }) as never;
  await assert.rejects(captureCheckoutOrder(first.paypalOrderId, { paypalCall: refuse, now: later(1) }), (e: unknown) => e instanceof CheckoutError && e.status === 422 && /not been charged/.test(e.message));
  assert.equal((await planRow(plan.id)).status, "approved", "terms unlocked, hold kept");
  assert.equal((await paymentRow(first.paypalOrderId)).status, "REFUSED");

  // PayPal's webhook redelivering APPROVED for the refused order: recorded once, never re-captured or retried forever.
  const spy = never();
  const res = await handleWebhookEvent({ id: `WH-refused-${first.paypalOrderId}`, event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: first.paypalOrderId, status: "APPROVED" } } as never, { capture: spy.fn });
  assert.equal(spy.called, false);
  assert.notEqual(res.status, "applied");
  await assert.rejects(captureCheckoutOrder(first.paypalOrderId, { paypalCall: refuse, now: later(1.1) }), (e: unknown) => e instanceof CheckoutError && e.status === 422);

  // Paying again asks PayPal for a new order (new request id), which can capture.
  const second = await checkout(o, plan, later(1.2));
  assert.notEqual(second.paypalOrderId, first.paypalOrderId);
  assert.match(created[created.length - 1].requestId ?? "", /-r1$/);
  const again = await checkout(o, plan, later(1.25));
  assert.equal(again.paypalOrderId, second.paypalOrderId, "double clicks still get one order");
  const done = await captureCheckoutOrder(second.paypalOrderId, { paypalCall: okCapture, now: later(1.3) });
  assert.equal(done.status, "COMPLETED");
  assert.equal((await planRow(plan.id)).status, "paid");
  assert.equal((await shares(plan.id)).length, (await partsOf(plan.id)).length);
});

test("the stateless MCP endpoint refuses GET instead of holding a function open", async () => {
  const { GET } = await import("@/app/api/mcp/route");
  const res = await GET();
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("Allow"), "POST");
});
