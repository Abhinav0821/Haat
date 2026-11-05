import { test } from "node:test";
import assert from "node:assert/strict";
import { computeEarnings, earningsSentenceHi, EconomicsSchema, type Earnings } from "@/lib/economics";

const rules = EconomicsSchema.parse({
  materialsInr: 350,
  packagingInr: 50,
  otherInr: 0,
  shippingCostInr: 1200, // what SHE pays the courier
  shippingChargeUsdCents: 1500, // what the BUYER pays for shipping
  minimumInr: 1500,
  piecesPerWeek: 4,
  feePercent: 5.4,
  feeFixedUsdCents: 30,
});
const ok = (x: ReturnType<typeof computeEarnings>) => {
  assert.ok("verdict" in x, "expected a full calculation");
  return x as Earnings;
};

test("one piece at $30: hand-checked arithmetic", () => {
  const x = ok(computeEarnings(rules, { unitPriceUsdCents: 3000, pieces: 1, inrPerUsd: 88 }));
  assert.equal(x.buyerPaysUsdCents, 4500); // $30 goods + $15 shipping charged
  assert.equal(x.estFeeUsdCents, 273); // 5.4% of $45 = $2.43, + $0.30
  assert.equal(x.estInrAfterPayPal, 3720); // $42.27 × 88
  assert.deepEqual(x.costs, { materials: 350, packaging: 50, other: 0, shipping: 1200, total: 1600 });
  assert.equal(x.leftForWorkInr, 2120);
  assert.equal(x.verdict, "meets_minimum");
});

test("shipping cost is per parcel, materials per piece — each deducted once", () => {
  const x = ok(computeEarnings(rules, { unitPriceUsdCents: 3000, pieces: 3, inrPerUsd: 88 }));
  assert.equal(x.costs.materials, 1050);
  assert.equal(x.costs.packaging, 150);
  assert.equal(x.costs.shipping, 1200, "one parcel");
  assert.equal(x.perPieceInr, Math.round(x.leftForWorkInr / 3));
});

test("below her minimum is not the same as a loss", () => {
  const x = ok(computeEarnings(rules, { unitPriceUsdCents: 1500, pieces: 1, inrPerUsd: 88 }));
  assert.ok(x.leftForWorkInr > 0);
  assert.equal(x.verdict, "below_minimum");
  assert.match(earningsSentenceHi(x, 1500), /कम है/);
  assert.doesNotMatch(earningsSentenceHi(x, 1500), /नुकसान/);
});

test("a genuine loss is called a loss", () => {
  const x = ok(computeEarnings({ ...rules, shippingChargeUsdCents: 0 }, { unitPriceUsdCents: 909, pieces: 1, inrPerUsd: 88 }));
  assert.ok(x.leftForWorkInr < 0);
  assert.equal(x.verdict, "loss");
  assert.match(earningsSentenceHi(x, 1500), /नुकसान/);
});

test("missing costs produce a question, not a number", () => {
  const r = computeEarnings({ ...rules, shippingCostInr: null, packagingInr: null }, { unitPriceUsdCents: 3000, pieces: 1, inrPerUsd: 88 });
  assert.ok(!("verdict" in r));
  assert.deepEqual(r.missing, ["packaging", "shipping cost"]);
});

test("every figure that is an estimate is labelled as one", () => {
  const x = ok(computeEarnings(rules, { unitPriceUsdCents: 3000, pieces: 1, inrPerUsd: 88 }));
  assert.ok(x.assumptions.some((a) => /fee estimated/.test(a)));
  assert.ok(x.assumptions.some((a) => /₹88 per \$1 estimated/.test(a)));
});
