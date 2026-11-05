import { test } from "node:test";
import assert from "node:assert/strict";
import { computeEarnings, EconomicsSchema } from "@/lib/economics";
import { completionDate, evaluateCounter, maxQuantityByDeadline, minimumUnitPriceUsdCents, validateOption, type CustomSpec, type Option } from "@/lib/custom/quote";

const rules = EconomicsSchema.parse({
  materialsInr: 350,
  packagingInr: 50,
  shippingCostInr: 1200,
  shippingChargeUsdCents: 1500,
  minimumInr: 1500,
  piecesPerWeek: 4,
  backlogPieces: 6, // already promised to other customers
  shippingDays: 10,
});
const now = new Date("2026-11-06T09:00:00Z");
const ctx = { now, inrPerUsd: 88 };
const request: CustomSpec = { quantity: 12, item: "hand block-printed cotton scarf", colors: ["red"], materials: ["cotton"], deadline: "2026-12-10", budgetUsdCents: null };
const opt = (o: Partial<Option>): Option => ({ quantity: 12, unitPriceUsdCents: 3500, completionBy: null, colors: null, materials: null, note: null, ...o });

test("capacity accounts for work already booked (not just pieces per week)", () => {
  // Dec 10 − 10 courier days = Nov 30 → 24 working days → 13 pieces, minus 6 already booked = 7
  assert.equal(maxQuantityByDeadline(now, new Date("2026-12-10"), 6, 4, 10), 7);
  assert.equal(maxQuantityByDeadline(now, new Date("2026-12-10"), 0, 4, 10), 13, "without the backlog, 12 would fit");
  assert.equal(completionDate(now, 6, 7, 4).toISOString().slice(0, 10), "2026-11-29");
});

test("an option she can't make in time is blocked, with the reason", () => {
  const v = validateOption(opt({ quantity: 8, completionBy: "2026-11-30" }), request, rules, ctx);
  assert.equal(v.status, "blocked");
  assert.ok(v.checks.some((c) => c.code === "date_not_possible" && c.blocking));
});

test("a feasible option: 7 pieces delivered before the deadline", () => {
  const v = validateOption(opt({ quantity: 7 }), request, rules, ctx);
  assert.equal(v.status, "valid");
  assert.equal(v.completion, "2026-11-29");
  assert.equal(v.delivery, "2026-12-09");
  assert.ok(v.checks.some((c) => c.code === "fewer_pieces"));
  assert.equal(v.totalUsdCents, 7 * 3500 + 1500);
});

test("all 12 later is allowed, but flagged for the buyer (completion and delivery kept separate)", () => {
  const v = validateOption(opt({ quantity: 12 }), request, rules, ctx);
  assert.equal(v.status, "valid");
  assert.equal(v.completion, "2026-12-08");
  assert.equal(v.delivery, "2026-12-18");
  assert.ok(v.checks.some((c) => c.code === "after_deadline" && !c.blocking));
});

test("a price below her minimum is blocked even when it isn't a loss", () => {
  const v = validateOption(opt({ quantity: 7, unitPriceUsdCents: 2200 }), request, rules, ctx);
  assert.equal(v.status, "blocked");
  const c = v.checks.find((c) => c.code === "below_minimum");
  assert.ok(c);
  assert.ok(v.earnings!.leftForWorkInr > 0, "positive, so not a loss");
});

test("minimum unit price is exact: it meets her minimum and one cent less does not", () => {
  const p = minimumUnitPriceUsdCents(rules, 7, 88)!;
  const at = computeEarnings(rules, { unitPriceUsdCents: p, pieces: 7, inrPerUsd: 88 });
  const below = computeEarnings(rules, { unitPriceUsdCents: p - 1, pieces: 7, inrPerUsd: 88 });
  assert.ok("verdict" in at && at.perPieceInr >= 1500);
  assert.ok("verdict" in below && below.perPieceInr < 1500);
});

test("a lowball counter-offer is refused with alternatives that respect her minimum", () => {
  const r = evaluateCounter({ quantity: 12, totalBudgetUsdCents: 25000 }, request, rules, ctx);
  assert.equal(r.acceptable, false);
  if (r.acceptable) return;
  assert.match(r.reasonEn, /below what the maker needs/);
  assert.ok(r.alternatives.length >= 1);
  for (const a of r.alternatives) {
    const x = computeEarnings(rules, { unitPriceUsdCents: a.unitPriceUsdCents, pieces: a.quantity, inrPerUsd: 88 });
    assert.ok("verdict" in x && x.perPieceInr >= 1500, `alternative ${a.quantity} pcs respects the minimum`);
  }
  const fewer = r.alternatives.find((a) => a.quantity < 12)!;
  assert.ok(fewer.unitPriceUsdCents * fewer.quantity + 1500 <= 25000, "fewer pieces fit the buyer's budget");
});

test("a fair counter-offer is acceptable", () => {
  const r = evaluateCounter({ quantity: 12, totalBudgetUsdCents: 30000 }, request, rules, ctx);
  assert.equal(r.acceptable, true);
});

test("missing costs or capacity block any quote", () => {
  const v = validateOption(opt({ quantity: 2 }), request, { ...rules, shippingCostInr: null, piecesPerWeek: null }, ctx);
  assert.equal(v.status, "blocked");
  assert.ok(v.checks.some((c) => c.code === "costs_missing"));
  assert.ok(v.checks.some((c) => c.code === "capacity_unknown"));
});

test("invoice check: same rules as Haat orders; the invoice total includes everything", async () => {
  const { invoiceCheck } = await import("@/lib/custom/invoice-check");
  const low = invoiceCheck(rules, { amountCents: 3000, pieces: 1, inrPerUsd: 88, backlogPieces: 6, now });
  assert.equal(low.verdict, "below_minimum");
  assert.equal(low.needsOverride, true);
  assert.match(low.hi, /कम है/);
  assert.equal(low.readyBy, "2026-11-19", "6 booked + 1 at 4/week → ceil(12.25) = 13 days after Nov 6");
  const loss = invoiceCheck(rules, { amountCents: 1000, pieces: 1, inrPerUsd: 88, backlogPieces: 0, now });
  assert.equal(loss.verdict, "loss");
  const fair = invoiceCheck(rules, { amountCents: 6000, pieces: 1, inrPerUsd: 88, backlogPieces: 0, now });
  assert.equal(fair.verdict, "meets_minimum");
  assert.equal(fair.needsOverride, false);
  const none = invoiceCheck(null, { amountCents: 6000, pieces: 1, inrPerUsd: 88, backlogPieces: 0, now });
  assert.equal(none.verdict, "unknown");
  assert.equal(none.needsOverride, false, "no rules → nothing to enforce, but she is told");
});

test("pilot report: custom-order metrics from logged events", async () => {
  const { pilotSummary } = await import("@/lib/pilot");
  const t = (min: number) => new Date(Date.UTC(2026, 10, 9, 10, min)).toISOString();
  const lines = pilotSummary([
    { name: "custom_request_created", props: { requestId: "a", channel: "web" }, at: t(0) },
    { name: "custom_request_created", props: { requestId: "b", channel: "mcp" }, at: t(1) },
    { name: "custom_options_drafted", props: { requestId: "a", options: 3, blocked: 1 }, at: t(3) },
    { name: "custom_options_sent", props: { requestId: "a", options: 2 }, at: t(4) },
    { name: "custom_options_sent", props: { requestId: "a", options: 1 }, at: t(9) },
    { name: "custom_counter", props: { requestId: "a", acceptable: false }, at: t(5) },
    { name: "agreement_approved", props: { requestId: "a", party: "seller", both: true }, at: t(6) },
  ]).join("\n");
  assert.match(lines, /requests received: 2 \(via AI agent: 1\)/);
  assert.match(lines, /options heard: 3, blocked by her own rules: 1/);
  assert.match(lines, /options sent\): 1; time from request to answer \(median\): 4\.0 min/, "first answer counts");
  assert.match(lines, /refused automatically: 1/);
  assert.match(lines, /approved by both: 1/);
});
