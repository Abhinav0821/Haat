import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, priceFor } from "@/lib/planner/solve";
import { checkEvaluation, checkPlan, checkOptimality, checkRefusal } from "@/lib/planner/check";
import type { CollectiveFacts, Evaluation, OrderRequest } from "@/lib/planner/model";
import { NOW, collective, maker } from "./planner-helpers";

const request = (quantity = 1, deliveryDay = 3, budgetUsdCents: number | null = null): OrderRequest => ({ quantity, deliveryDay, budgetUsdCents });
function facts(makers = [maker("a", { cap: [2, 1, 1, 1], ask: 100, floor: 50 })]): CollectiveFacts {
  const f = collective({ H: 4, fin: [10, 10, 10, 10], makers, costs: {
    finishingInrPerPiece: 0, packagingInrPerPiece: 0, collectionInrPerPiece: 0, chargeInrPerPiece: 0, shippingInrPerOrder: 0,
  } });
  f.fee = { percent: 0, fixedUsdCents: 0 };
  f.inrPerUsd.value = 100;
  return f;
}
function feasible(f: CollectiveFacts, r: OrderRequest) {
  const ev = evaluate(f, r, NOW);
  assert.equal(ev.kind, "feasible");
  if (ev.kind !== "feasible") throw new Error("Expected a feasible fixture");
  assert.deepEqual(checkEvaluation(f, r, ev, NOW), []);
  return ev;
}
function budgetRefusal(f: CollectiveFacts, r: OrderRequest) {
  const ev = evaluate(f, r, NOW);
  assert.equal(ev.kind, "infeasible_budget");
  if (ev.kind !== "infeasible_budget") throw new Error("Expected a budget fixture");
  assert.deepEqual(checkEvaluation(f, r, ev, NOW), []);
  return ev;
}

test("incomplete makers permit a yes, but not a global cheapest claim or a budget refusal", () => {
  const f = facts([maker("cheap", { cap: [1, 0, 0, 0], ask: 100, floor: 50, ready: null }), maker("dear", { cap: [1, 0, 0, 0], ask: 1000, floor: 700 })]);
  const r = request(1, 3, 500);
  assert.equal(evaluate(f, r, NOW).kind, "unresolved");
  const yes = feasible(f, request());
  assert.equal(yes.certified, false);
  assert.ok(checkOptimality(f, yes.plan, yes.optimality, NOW).length);
  const forged = structuredClone(yes);
  forged.certified = true;
  assert.ok(checkEvaluation(f, request(), forged, NOW).length);
  f.makers[0].materialsReadyDay = { value: 0, prov: f.makers[0].dailyCapacity.prov };
  assert.equal(feasible(f, r).plan.money.priceUsdCents, 100);
});

test("money is derived from production, so duplicate pay lines cannot omit or underpay a maker", () => {
  const f = facts([maker("a", { cap: [1, 0, 0, 0], ask: 100, floor: 50, max: 1 }), maker("b", { cap: [1, 0, 0, 0], ask: 1000, floor: 700, max: 1 })]);
  const r = request(2);
  const ev = feasible(f, r);
  assert.equal(ev.plan.money.totalCostInr, 1100);
  ev.plan.money.perMaker = [ev.plan.money.perMaker[0], structuredClone(ev.plan.money.perMaker[0])];
  ev.plan.money.makersInr = ev.plan.money.totalCostInr = ev.plan.money.priceUsdCents = 200;
  assert.ok(checkEvaluation(f, r, ev, NOW).length);
});

test("every displayed money field is verified", () => {
  const f = facts(), r = request(), ev = feasible(f, r);
  for (const key of ["makersInr", "finishingInr", "packagingInr", "collectionInr", "chargeInr", "shippingInr", "estFeeUsdCents"] as const) {
    const bad = structuredClone(ev);
    bad.plan.money[key] += 1;
    assert.ok(checkEvaluation(f, r, bad, NOW).length, key);
  }
});

test("budget refusals are bound to the exact quantity, date and budget", () => {
  const f = facts(), r = request(2, 3, 150);
  const ev = budgetRefusal(f, r);
  assert.equal(feasible(f, request(1, 3, 150)).plan.money.priceUsdCents, 100);
  for (const other of [request(1, 3, 150), request(2, 4, 150), request(2, 3, 250), request(2, 3, null)]) {
    assert.ok(checkEvaluation(f, other, ev, NOW).length, JSON.stringify(other));
  }
});

test("budget alternatives cannot bypass checking", () => {
  const f = facts(), r = request(2, 3, 150), ev = budgetRefusal(f, r);
  const alt = ev.alternatives.largestWithinBudget;
  assert.ok(alt && "plan" in alt);
  if (!alt || !("plan" in alt)) return;
  alt.quantity = 999;
  alt.plan.quantity = 999;
  assert.ok(checkEvaluation(f, r, ev, NOW).length);
});

test("an earliest-delivery claim requires a preceding-day refusal and the full requested quantity", () => {
  const f = facts([maker("a", { cap: [1, 1, 1, 1], ask: 100, floor: 50 })]);
  const r = request(3, 2), ev = evaluate(f, r, NOW);
  assert.equal(ev.kind, "infeasible_capacity");
  if (ev.kind !== "infeasible_capacity") return;
  assert.deepEqual(checkEvaluation(f, r, ev, NOW), []);
  const late = feasible(f, request(3, 5));
  ev.alternatives.earliestDelivery = { kind: "found", plan: late.plan, optimality: late.optimality, certified: false, dayBeforeCut: null };
  assert.ok(checkEvaluation(f, r, ev, NOW).length);
});

test("negative lag and a 100% fee are unresolved and independently rejected", () => {
  const f = facts(), r = request(), ev = feasible(f, r);
  for (const mutate of [(x: CollectiveFacts) => { x.lagDays = -1; }, (x: CollectiveFacts) => { x.fee.percent = 100; }]) {
    const bad = structuredClone(f);
    mutate(bad);
    assert.equal(evaluate(bad, r, NOW).kind, "unresolved");
    assert.ok(checkPlan(bad, r, ev.plan, NOW).length);
  }
});

test("fractional days and non-finite certificate/plan values are rejected", () => {
  const f = facts(), r = request(), ev = feasible(f, r);
  const bad = structuredClone(ev);
  bad.plan.production.push({ makerId: "a", day: 0.5, pieces: 1 });
  assert.ok(checkEvaluation(f, r, bad, NOW).length);
  for (const n of [NaN, Infinity, -Infinity]) {
    const p = structuredClone(ev.plan);
    p.money.priceUsdCents = n;
    assert.ok(checkPlan(f, r, p, NOW).length);
  }
});

test("all supported budget boundaries, including zero, carry a next-quantity proof", () => {
  const f = facts();
  for (const budget of [0, 99, 100, 199, 200, 299]) {
    const r = request(3, 3, budget), ev = budgetRefusal(f, r);
    const alt = ev.alternatives.largestWithinBudget!;
    assert.equal(alt.quantity, Math.floor(budget / 100));
    assert.equal(alt.next.plan.quantity, alt.quantity + 1);
    assert.ok(alt.next.plan.money.priceUsdCents > budget);
    const noProof = structuredClone(ev);
    delete (noProof.alternatives.largestWithinBudget as unknown as Record<string, unknown>).next;
    assert.ok(checkEvaluation(f, r, noProof, NOW).length, "a zero claim needs proof too");
  }
});

test("a feasible but smaller alternative cannot be called the largest within budget", () => {
  const f = facts(), r = request(3, 3, 250), ev = budgetRefusal(f, r);
  const one = feasible(f, request(1, 3, 250)), two = feasible(f, request(2, 3, 250));
  ev.alternatives.largestWithinBudget = { quantity: 1, plan: one.plan, optimality: one.optimality, certified: true, next: { plan: two.plan, optimality: two.optimality } };
  assert.ok(checkEvaluation(f, r, ev, NOW).some((s) => /not maximal/.test(s)));
  ev.alternatives.largestWithinBudget = { quantity: 0, next: { plan: one.plan, optimality: one.optimality } };
  assert.ok(checkEvaluation(f, r, ev, NOW).some((s) => /not maximal/.test(s)));
});

test("maximum-by-date claims require a feasible witness reaching the cut", () => {
  const f = facts(), r = request(20), ev = evaluate(f, r, NOW);
  assert.equal(ev.kind, "infeasible_capacity");
  if (ev.kind !== "infeasible_capacity") return;
  assert.deepEqual(checkEvaluation(f, r, ev, NOW), []);
  const missing = structuredClone(ev);
  missing.alternatives.largestByDate!.plan = null;
  assert.ok(checkEvaluation(f, r, missing, NOW).length);
  const wrongQuantity = structuredClone(ev);
  wrongQuantity.alternatives.largestByDate!.quantity -= 1;
  assert.ok(checkEvaluation(f, r, wrongQuantity, NOW).length);
  const wrongHorizon = structuredClone(ev);
  if (wrongHorizon.alternatives.earliestDelivery?.kind === "not_within_horizon") {
    wrongHorizon.alternatives.earliestDelivery.horizonDays += 1;
    assert.ok(checkEvaluation(f, r, wrongHorizon, NOW).length);
  } else assert.fail("fixture must exceed the horizon's capacity");
});

test("earliest-delivery certificates cannot substitute a smaller order", () => {
  const f = facts([maker("a", { cap: [1, 1, 1, 1], ask: 100, floor: 50 })]);
  const r = request(3, 2), ev = evaluate(f, r, NOW);
  if (ev.kind !== "infeasible_capacity" || ev.alternatives.earliestDelivery?.kind !== "found") throw Error("bad fixture");
  ev.alternatives.earliestDelivery.plan = feasible(f, request(1, 4)).plan;
  assert.ok(checkEvaluation(f, r, ev, NOW).length);
});

test("cut fields and claimed optimality bounds are checked, not just recomputed silently", () => {
  const f = facts([maker("a", { cap: [1, 0, 0, 0], ask: 100, floor: 50 }), maker("b", { cap: [1, 0, 0, 0], ask: 200, floor: 50 })]);
  const r = request(2), ev = feasible(f, r);
  assert.ok(ev.optimality.levels[0].cut);
  ev.optimality.levels[0].cut!.bound -= 1;
  assert.ok(checkEvaluation(f, r, ev, NOW).length);
  const no = evaluate(f, request(3), NOW);
  if (no.kind !== "infeasible_capacity") throw Error("bad fixture");
  for (const field of ["tau", "bound"] as const) for (const n of [NaN, Infinity, 0.5, -1]) {
    const cut = structuredClone(no.cut);
    cut[field] = n;
    assert.ok(checkRefusal(f, request(3), cut, NOW).length, `${field}=${n}`);
  }
});

test("fact bounds are enforced by both the solver and the independent checker", () => {
  const mutations: [string, (f: CollectiveFacts) => void][] = [
    ["negative packing", (f) => { f.packDays = -1; }],
    ["fractional lag", (f) => { f.lagDays = 0.5; }],
    ["fractional transit", (f) => { f.transitDays.value = 0.5; }],
    ["zero rate", (f) => { f.inrPerUsd.value = 0; }],
    ["non-finite rate", (f) => { f.inrPerUsd.value = Infinity; }],
    ["negative cost", (f) => { f.costs.shippingInrPerOrder = -1; }],
    ["non-finite ask", (f) => { f.makers[0].askInrPerPiece.value = NaN; }],
    ["negative floor", (f) => { f.makers[0].floorInrPerPiece.value = -1; }],
    ["negative limit", (f) => { f.makers[0].maxPieces = { value: -1, prov: f.makers[0].dailyCapacity.prov }; }],
    ["fractional ready day", (f) => { f.makers[0].materialsReadyDay!.value = 0.5; }],
    ["negative promise", (f) => { f.makers[0].commitments.value = [{ ref: "bad", pieces: -1, dueDay: 1 }]; }],
    ["negative reservation", (f) => { f.reservations = [{ planId: "bad", production: [{ makerId: "a", day: 0, pieces: -1 }], finishing: [] }]; }],
    ["fractional reservation day", (f) => { f.reservations = [{ planId: "bad", production: [], finishing: [{ day: 0.5, pieces: 1 }] }]; }],
    ["unknown reserved maker", (f) => { f.reservations = [{ planId: "bad", production: [{ makerId: "absent", day: 0, pieces: 1 }], finishing: [] }]; }],
    ["duplicate maker IDs", (f) => { f.makers.push(structuredClone(f.makers[0])); }],
    ["duplicate reservations", (f) => { f.reservations = [{ planId: "same", production: [], finishing: [] }, { planId: "same", production: [], finishing: [] }]; }],
    ["bad confirmation time", (f) => { f.makers[0].dailyCapacity.prov.at = "not a date"; }],
    ["future confirmation", (f) => { f.makers[0].dailyCapacity.prov.at = "2027-01-01T00:00:00Z"; }],
    ["invalid calendar date", (f) => { f.startDate = "2026-02-30"; }],
    ["sparse capacity", (f) => { delete f.makers[0].dailyCapacity.value[1]; }],
    ["huge horizon", (f) => { f.horizonDays = 1_000_000; }],
  ];
  const r = request(), valid = facts(), plan = feasible(valid, r).plan;
  for (const [name, change] of mutations) {
    const f = structuredClone(valid);
    change(f);
    const ev = evaluate(f, r, NOW);
    assert.equal(ev.kind, "unresolved", name);
    assert.ok(checkPlan(f, r, plan, NOW).length, name);
    assert.deepEqual(checkEvaluation(f, r, ev, NOW), [], `${name}: unresolved remains a legitimate answer`);
  }
});

test("invalid requests and malformed external results fail closed without throwing", () => {
  const f = facts(), r = request(), ev = feasible(f, r);
  const requests = [request(0), request(0.5), request(1, 0.5), request(1, 3, NaN), request(1, 3, -1)];
  for (const bad of requests) {
    assert.equal(evaluate(f, bad, NOW).kind, "unresolved");
    assert.ok(checkEvaluation(f, bad, ev, NOW).length);
  }
  for (const value of [null, {}, { kind: "feasible" }, { kind: "unresolved", issues: [null] }, { kind: "unknown" }]) {
    assert.ok(checkEvaluation(f, r, value as unknown as Evaluation, NOW).length);
  }
  for (const value of [null, {}, { ...f, costs: null }]) {
    const bad = value as unknown as CollectiveFacts;
    assert.equal(evaluate(bad, r, NOW).kind, "unresolved");
    assert.ok(checkPlan(bad, r, ev.plan, NOW).length);
  }
});

test("stale makers and unknown future capacity cannot support a cheapest claim", () => {
  const f = facts([maker("a", { cap: [1, 0, 0, 0], ask: 100, floor: 50, confirmedAt: "2026-10-01T00:00:00Z" }), maker("b", { cap: [1, 0, 0, 0], ask: 200, floor: 50 })]);
  assert.equal(feasible(f, request()).certified, false);
  assert.equal(evaluate(f, request(1, 3, 150), NOW).kind, "unresolved");
  const known = facts();
  assert.equal(feasible(known, request(1, 10)).certified, false);
  assert.equal(evaluate(known, request(1, 10, 50), NOW).kind, "unresolved");
});

test("bounded pricing handles fee, exchange-rate and cent rounding extremes", () => {
  for (const rate of [0.01, 1, 88, 10_000]) for (const percent of [0, 5.4, 20]) for (const fixedUsdCents of [0, 30, 1_000_000]) {
    const f = facts();
    f.inrPerUsd.value = rate; f.fee = { percent, fixedUsdCents };
    const ev = feasible(f, request());
    assert.ok(Number.isSafeInteger(ev.plan.money.priceUsdCents));
  }
  for (const rate of [0, -1, Infinity, NaN]) assert.throws(() => priceFor(100, { percent: 5.4, fixedUsdCents: 30 }, rate));
  for (const percent of [-1, 100, Infinity, NaN]) assert.throws(() => priceFor(100, { percent, fixedUsdCents: 30 }, 88));
  const f = facts([maker("a", { cap: [1, 0, 0, 0], ask: 100.01, floor: 50 }), maker("b", { cap: [1, 0, 0, 0], ask: 100.02, floor: 50 })]);
  assert.equal(feasible(f, request(2)).plan.money.makersInr, 200.03);
});
