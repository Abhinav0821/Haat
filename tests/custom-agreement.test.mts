import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.PGLITE_DIR = "memory://";
process.env.PAYPAL_CLIENT_ID ??= "test";
process.env.PAYPAL_CLIENT_SECRET ??= "test";
process.env.GOOGLE_API_KEY ??= "test";

const { db, schema } = await import("@/db");
const { eq } = await import("drizzle-orm");
const ag = await import("@/lib/custom/agreement");
const svc = await import("@/lib/custom/requests");
const { captureCheckoutOrder, CheckoutError } = await import("@/lib/paypal/orders");
const { specFrom, optionsFrom } = await import("@/lib/ai/custom");

type DB = Awaited<ReturnType<typeof db>>;
let d: DB;
let storeId: string;

const rules = {
  materialsInr: 350,
  packagingInr: 50,
  otherInr: 0,
  shippingCostInr: 1200,
  shippingChargeUsdCents: 1500,
  minimumInr: 1500,
  piecesPerWeek: 4,
  backlogPieces: 6,
  shippingDays: 10,
  askBeforeChanges: true,
  feePercent: 5.4,
  feeFixedUsdCents: 30,
};

// The AI is replaced by fixed extractions: these tests are about what CODE allows.
const fakeBuyer = async () => ({
  quantity: 12,
  item: "hand block-printed cotton scarf",
  itemHi: "हाथ से छपा सूती दुपट्टा",
  colors: ["red"],
  materials: ["cotton"],
  deadline: new Date(Date.now() + 34 * 86_400_000).toISOString().slice(0, 10),
  budget: null,
  otherWishes: null,
});
const fakeSeller = (options: { quantity: number; usd: number }[]) => async () => ({
  transcript: "…",
  decline: false,
  options: options.map((o) => ({ quantity: o.quantity, price: { amount: o.usd, currency: "USD" as const, basis: "per_piece" as const }, completionBy: null, colors: null, materials: null, note: null })),
});

before(async () => {
  d = await db();
  const [s] = await d.insert(schema.stores).values({ slug: `custom-${randomUUID()}`, name: "Meera Block Prints", ownerName: "Meera", policy: { economics: rules } }).returning();
  storeId = s.id;
});

async function requestWithAgreement(options = [{ quantity: 7, usd: 35 }]) {
  const r = await svc.createCustomRequest(storeId, { buyerText: "12 red cotton scarves for my bridesmaids please", channel: "web" }, { hear: fakeBuyer });
  await svc.draftAnswer(r.id, { text: "x" }, { hear: fakeSeller(options) });
  await svc.sendOptions(r.id, [0]);
  const a = await svc.chooseOption(r.id, { kind: "option", index: 0 });
  return { r, a };
}

async function agreementOrder(a: { id: string; termsHash: string }, paypalOrderId = `AG${randomUUID().replace(/-/g, "").slice(0, 14).toUpperCase()}`) {
  const [o] = await d
    .insert(schema.orders)
    .values({ storeId, paypalOrderId, status: "APPROVED", amountCents: 1, currency: "USD", items: [], channel: "custom", agreementId: a.id, termsHash: a.termsHash })
    .returning();
  return o;
}

const okCapture = (async () => ({
  status: "COMPLETED",
  purchase_units: [{ payments: { captures: [{ id: "CAP1", status: "COMPLETED" }] } }],
})) as never;

test("the hash covers every term: change any field and the hash changes", () => {
  const t: import("@/lib/custom/agreement").Terms = {
    v: 1, shop: "s", maker: "m", item: "scarf", quantity: 7, unitPriceUsdCents: 3500, shippingUsdCents: 1500, totalUsdCents: 26000,
    colors: ["red"], materials: ["cotton"], completionBy: "2026-11-29", deliveryEstimate: "2026-12-09", handmadeVariation: "h", refundTerms: "r", note: null,
  };
  const h = ag.hashTerms(t);
  assert.equal(h, ag.hashTerms({ ...t }), "deterministic");
  for (const [k, v] of [["quantity", 8], ["unitPriceUsdCents", 3400], ["completionBy", "2026-11-30"], ["colors", ["blue"]], ["note", "x"]] as const) {
    assert.notEqual(ag.hashTerms({ ...t, [k]: v }), h, `${k} is covered`);
  }
});

test("a blocked option can never be sent to the buyer", async () => {
  const r = await svc.createCustomRequest(storeId, { buyerText: "12 red cotton scarves for my bridesmaids please", channel: "web" }, { hear: fakeBuyer });
  const drafted = await svc.draftAnswer(r.id, { text: "x" }, { hear: fakeSeller([{ quantity: 12, usd: 20 }]) });
  assert.equal(drafted.verdicts[0].status, "blocked", "$20 each is below her minimum");
  await assert.rejects(svc.sendOptions(r.id, [0]), /blocked option/);
});

test("payment is impossible until BOTH approve the exact current terms", async () => {
  const { r, a } = await requestWithAgreement();
  assert.ok(ag.payableProblem(a), "fresh proposal is not payable");
  await assert.rejects(svc.buyerApprove(r.id, a.id, "0".repeat(64)), /terms changed/, "approving a different hash is refused");
  await svc.buyerApprove(r.id, a.id, a.termsHash);
  const [mid] = await d.select().from(schema.agreements).where(eq(schema.agreements.id, a.id));
  assert.match(ag.payableProblem(mid)!, /Both/, "buyer alone is not enough");
  const both = await svc.sellerApprove(r.id, a.id, a.termsHash);
  assert.equal(both.status, "approved");
  assert.equal(ag.payableProblem(both), null);
  assert.ok(both.holdUntil! > new Date(), "capacity is held while unpaid");
});

test("a change supersedes the old version and voids its approvals, even mid-checkout", async () => {
  const { r, a } = await requestWithAgreement([{ quantity: 7, usd: 35 }, { quantity: 6, usd: 40 }]);
  await svc.sendOptions(r.id, [0, 1]);
  await svc.buyerApprove(r.id, a.id, a.termsHash);
  await svc.sellerApprove(r.id, a.id, a.termsHash);
  const order = await agreementOrder(a); // buyer opened PayPal on v1…

  const v2 = await svc.chooseOption(r.id, { kind: "option", index: 1 }); // …then terms changed
  assert.equal(v2.version, a.version + 1);
  const [old] = await d.select().from(schema.agreements).where(eq(schema.agreements.id, a.id));
  assert.equal(old.status, "superseded");
  assert.equal(old.supersededById, v2.id);
  await assert.rejects(svc.buyerApprove(r.id, a.id, a.termsHash), /replaced/, "can't approve the old version");

  let called = false;
  const spy = (async () => {
    called = true;
    return {};
  }) as never;
  await assert.rejects(captureCheckoutOrder(order.paypalOrderId, { paypalCall: spy }), (e: unknown) => e instanceof CheckoutError && /replaced/.test((e as Error).message));
  assert.equal(called, false, "PayPal capture is never called for superseded terms");
});

test("capture of the approved, current terms marks the agreement and request paid", async () => {
  const { r, a } = await requestWithAgreement();
  await svc.buyerApprove(r.id, a.id, a.termsHash);
  await svc.sellerApprove(r.id, a.id, a.termsHash);
  const order = await agreementOrder(a);
  const res = await captureCheckoutOrder(order.paypalOrderId, { paypalCall: okCapture });
  assert.equal(res.status, "COMPLETED");
  const [after] = await d.select().from(schema.agreements).where(eq(schema.agreements.id, a.id));
  assert.equal(after.status, "paid");
  assert.equal(after.orderId, order.id);
  assert.equal((await svc.loadRequest(r.id)).status, "paid");
});

test("an order whose hash doesn't match the agreement is refused", async () => {
  const { r, a } = await requestWithAgreement();
  await svc.buyerApprove(r.id, a.id, a.termsHash);
  await svc.sellerApprove(r.id, a.id, a.termsHash);
  const order = await agreementOrder({ id: a.id, termsHash: "f".repeat(64) });
  await assert.rejects(captureCheckoutOrder(order.paypalOrderId, { paypalCall: okCapture }), /changed after checkout/);
});

test("an expired approval hold must be re-approved before payment", async () => {
  const { r, a } = await requestWithAgreement();
  await svc.buyerApprove(r.id, a.id, a.termsHash);
  await svc.sellerApprove(r.id, a.id, a.termsHash);
  await d.update(schema.agreements).set({ holdUntil: new Date(Date.now() - 1000) }).where(eq(schema.agreements.id, a.id));
  const [x] = await d.select().from(schema.agreements).where(eq(schema.agreements.id, a.id));
  assert.match(ag.payableProblem(x)!, /expired/);
});

test("approved agreements count as booked work for the next request", async () => {
  const e = { ...rules };
  const before = await ag.effectiveBacklog(storeId, e);
  const { r, a } = await requestWithAgreement();
  await svc.buyerApprove(r.id, a.id, a.termsHash);
  await svc.sellerApprove(r.id, a.id, a.termsHash);
  assert.equal(await ag.effectiveBacklog(storeId, e), before + 7);
  assert.equal(await ag.effectiveBacklog(storeId, e, { excludeRequestId: r.id }), before, "a request doesn't compete with itself");
});

test("a lowball counter is refused with alternatives; a fair one becomes a proposal she must still approve", async () => {
  const r = await svc.createCustomRequest(storeId, { buyerText: "12 red cotton scarves for my bridesmaids please", channel: "web" }, { hear: fakeBuyer });
  const low = await svc.counterOffer(r.id, { quantity: 3, totalBudgetUsdCents: 6000 });
  assert.equal(low.result.acceptable, false);
  assert.equal(low.agreementId, null);
  const fair = await svc.counterOffer(r.id, { quantity: 2, totalBudgetUsdCents: 20000 });
  assert.equal(fair.result.acceptable, true);
  const v = await svc.buyerView(r.id);
  assert.equal(v.agreement?.id, fair.agreementId);
  assert.equal(v.agreement?.sellerApproved, false, "the maker still approves");
  assert.equal(v.agreement?.payable, false);
});

test("the buyer view never exposes her costs or earnings", async () => {
  const { r } = await requestWithAgreement();
  const json = JSON.stringify(await svc.buyerView(r.id));
  for (const secret of ["earnings", "perPieceInr", "leftForWork", "minimumInr", "materialsInr", "costs"]) assert.ok(!json.includes(secret), secret);
});

test("extraction outputs are normalised by code (currency, per-piece vs total, bounds)", async () => {
  const spec = specFrom({ ...(await fakeBuyer()), quantity: 500, budget: { amount: 22000, currency: "INR", basis: "total" } }, 88);
  assert.equal(spec.quantity, 200, "quantity is bounded");
  assert.equal(spec.budgetUsdCents, 25000, "₹22,000 ≈ $250");
  const opts = optionsFrom({ transcript: "", decline: false, options: [{ quantity: 7, price: { amount: 21560, currency: "INR", basis: "total" }, completionBy: "soon", colors: null, materials: null, note: null }] }, 88);
  assert.equal(opts[0].unitPriceUsdCents, 3500, "₹21,560 for 7 → $35.00 each");
  assert.equal(opts[0].completionBy, null, "non-dates are dropped");
});


test("a lapsed hold releases her time and asks both to approve again", async () => {
  const { r, a } = await requestWithAgreement();
  await svc.buyerApprove(r.id, a.id, a.termsHash);
  await svc.sellerApprove(r.id, a.id, a.termsHash);
  await d.update(schema.agreements).set({ holdUntil: new Date(Date.now() - 1000) }).where(eq(schema.agreements.id, a.id));
  const v = await svc.buyerView(r.id);
  assert.equal(v.agreement?.status, "proposed");
  assert.equal(v.agreement?.buyerApproved, false);
  assert.equal(v.agreement?.sellerApproved, false);
  await svc.buyerApprove(r.id, a.id, a.termsHash);
  const again = await svc.sellerApprove(r.id, a.id, a.termsHash);
  assert.equal(again.status, "approved", "re-approved after a fresh capacity check");
});

test("an invoice below her rules is not created without an explicit override", async () => {
  const { confirmAskAction } = await import("@/lib/ask/agent");
  const check = { verdict: "below_minimum", needsOverride: true, hi: "", en: "", perPieceInr: 900, readyBy: null };
  const [action] = await d
    .insert(schema.agentActions)
    .values({ storeId, agent: "ask", tool: "create_invoice", input: { buyerName: "Sara", item: "Scarf", amountCents: 3000, amountInr: 2640, check }, summaryHi: "x", status: "proposed" })
    .returning();
  const r = await confirmAskAction(action.id, storeId);
  assert.ok("error" in r && "needsOverride" in r);
  const [still] = await d.select().from(schema.agentActions).where(eq(schema.agentActions.id, action.id));
  assert.equal(still.status, "proposed", "nothing was sent to PayPal; she can still confirm or cancel");
});

after(async () => (await import("@/db")).closeDb());
