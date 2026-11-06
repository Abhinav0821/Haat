import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "@/lib/planner/solve";
import { checkEvaluation, checkOptimality, checkPlan, checkRefusal } from "@/lib/planner/check";
import { dayIndex, weeklyToDaily, type CollectiveFacts, type Evaluation, type OrderRequest, type Plan } from "@/lib/planner/model";
import { maxQuantityByDeadline } from "@/lib/custom/quote";
import { NOW, collective, daily, maker } from "./planner-helpers";

const H = 40;
// Three makers: Meera 25, Sita 20 (materials on day 5), Rani 15 (10 days off) by day 24.
const off = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
const team = () => [
  maker("meera", { cap: daily(1, H), ask: 950, floor: 800 }),
  maker("sita", { cap: daily(1, H), ready: 5, ask: 900, floor: 750 }),
  maker("rani", { cap: daily(1, H, off), ask: 1000, floor: 850 }),
];
// transit 3 + packing 1 → delivery day 30 means the last finishing day is 25.
const base = (fin: number[], extra: Partial<Parameters<typeof collective>[0]> = {}) => collective({ H, fin, makers: team(), transit: 3, pack: 1, ...extra });
const req = (quantity: number, deliveryDay = 30, budgetUsdCents: number | null = null): OrderRequest => ({ quantity, deliveryDay, budgetUsdCents });

function verified(facts: CollectiveFacts, r: OrderRequest): Evaluation {
  const ev = evaluate(facts, r, NOW);
  assert.deepEqual(checkEvaluation(facts, r, ev, NOW), [], "the independent checker accepts every part of the answer");
  return ev;
}

test("three makers together fulfil 60 that none could alone; the plan is certified cheapest", () => {
  const facts = base(daily(3, H));
  const ev = verified(facts, req(60));
  assert.equal(ev.kind, "feasible");
  if (ev.kind !== "feasible") return;
  assert.equal(ev.certified, true);
  const by = Object.fromEntries(ev.plan.money.perMaker.map((p) => [p.makerId, p.pieces]));
  assert.deepEqual(by, { meera: 25, sita: 20, rani: 15 });
  for (const solo of ["meera", "sita", "rani"]) {
    const alone = verified({ ...facts, makers: facts.makers.filter((m) => m.id === solo) }, req(60));
    assert.equal(alone.kind, "infeasible_capacity", `${solo} alone can't`);
  }
});

test("cheaper makers are used first when there is slack, and that is certified", () => {
  const facts = base(daily(3, H));
  const ev = verified(facts, req(40));
  assert.equal(ev.kind, "feasible");
  if (ev.kind !== "feasible") return;
  assert.equal(ev.certified, true);
  const by = Object.fromEntries(ev.plan.money.perMaker.map((p) => [p.makerId, p.pieces]));
  assert.equal(by.sita, 20, "cheapest maker at her full capacity");
  assert.equal(by.meera, 20, "next cheapest fills the rest");
  assert.equal(by.rani, undefined);
});

test("finishing bottleneck: a certified 'no' that says why, the largest quantity, and the earliest date", () => {
  // Finishing table only from day 10, 3 a day: 3 × 16 days (10…25) = 48 — but only 42 by day 23.
  const fin = Array.from({ length: H }, (_, t) => (t >= 10 ? 3 : 0));
  const facts = base(fin);
  const ev = verified(facts, req(60, 28)); // last finishing day 23
  assert.equal(ev.kind, "infeasible_capacity");
  if (ev.kind !== "infeasible_capacity") return;
  assert.equal(ev.maxQuantity, 42);
  assert.equal(ev.cut.tau, 0, "the binding constraint is finishing alone: 42 before dispatch");
  assert.ok(ev.cut.makers.every((m) => m.u === 0), "no maker capacity is part of the bound");
  assert.equal(ev.alternatives.largestByDate?.quantity, 42);
  const ed = ev.alternatives.earliestDelivery;
  assert.equal(ed?.kind, "found");
  if (ed?.kind === "found") {
    assert.equal(ed.plan.deliveryDay, 34, "60 pieces need finishing through day 29");
    assert.ok(ed.dayBeforeCut && ed.dayBeforeCut.bound < 60);
  }
});

test("'not within the horizon' is not 'never'", () => {
  const fin = Array.from({ length: H }, (_, t) => (t >= 30 ? 1 : 0));
  const ev = verified(base(fin), req(60));
  assert.equal(ev.kind, "infeasible_capacity");
  if (ev.kind === "infeasible_capacity") assert.equal(ev.alternatives.earliestDelivery?.kind, "not_within_horizon");
});

test("a missing material date never becomes 'impossible'", () => {
  const facts = base(daily(3, H));
  facts.makers[1] = maker("sita", { cap: daily(1, H), ready: null, ask: 900, floor: 750 });
  const ev = verified(facts, req(60));
  assert.equal(ev.kind, "unresolved");
  if (ev.kind === "unresolved") {
    assert.ok(ev.issues.some((i) => i.code === "missing" && i.makerId === "sita"));
    assert.equal(ev.partial?.maxQuantity, 40, "what the confirmed facts alone support");
  }
  // …but a plan that doesn't need her is still a valid yes.
  const small = verified(facts, req(30));
  assert.equal(small.kind, "feasible");
});

test("stale availability blocks a refusal; beyond-horizon dates are unresolved, not refused", () => {
  const facts = base(daily(3, H));
  facts.makers[0] = maker("meera", { cap: daily(1, H), ask: 950, floor: 800, confirmedAt: "2026-10-01T00:00:00Z" });
  const ev = verified(facts, req(60));
  assert.equal(ev.kind, "unresolved");
  if (ev.kind === "unresolved") assert.ok(ev.issues.some((i) => i.code === "stale"));

  const far = verified(base(daily(0, H)), req(5, 60));
  assert.equal(far.kind, "unresolved");
  if (far.kind === "unresolved") assert.ok(far.issues.some((i) => i.code === "beyond_horizon"));
});

test("per-maker fixed costs are reported as unsupported, not silently ignored", () => {
  const facts = base(daily(3, H));
  facts.makers[2] = maker("rani", { cap: daily(1, H, off), ask: 1000, floor: 850, fixed: 300 });
  const ev = verified(facts, req(10));
  assert.equal(ev.kind, "unresolved");
  if (ev.kind === "unresolved") assert.ok(ev.issues.some((i) => i.code === "unsupported"));
});

test("budget refusal rests on a certified minimum cost; the largest quantity within budget is offered", () => {
  const facts = base(daily(3, H));
  const full = evaluate(facts, req(60), NOW);
  assert.equal(full.kind, "feasible");
  const minPrice = full.kind === "feasible" ? full.plan.money.priceUsdCents : 0;
  const ev = verified(facts, req(60, 30, minPrice - 1));
  assert.equal(ev.kind, "infeasible_budget");
  if (ev.kind !== "infeasible_budget") return;
  assert.equal(ev.certified, true);
  const lw = ev.alternatives.largestWithinBudget!;
  assert.ok(lw.quantity > 0 && lw.quantity < 60);
  if ("plan" in lw) assert.ok(lw.plan.money.priceUsdCents <= minPrice - 1);
  // exactly the minimum price is fine
  assert.equal(verified(facts, req(60, 30, minPrice)).kind, "feasible");
});

test("her other promises keep their dates; a maker's limit on pieces is respected", () => {
  const facts = base(daily(3, H));
  facts.makers[0] = maker("meera", { cap: daily(1, H), ask: 950, floor: 800, commits: [{ ref: "shop", pieces: 10, dueDay: 12 }], max: 12 });
  const ev = verified(facts, req(45));
  assert.equal(ev.kind, "feasible");
  if (ev.kind === "feasible") assert.ok(ev.plan.money.perMaker.find((p) => p.makerId === "meera")!.pieces <= 12);
  const no = verified(facts, req(48));
  assert.equal(no.kind, "infeasible_capacity");
  if (no.kind === "infeasible_capacity") assert.ok(no.cut.makers.some((m) => m.makerId === "meera"));
});

// ---------- the checker must reject wrong answers ----------

function feasiblePlan(): { facts: CollectiveFacts; r: OrderRequest; plan: Plan } {
  const facts = base(daily(3, H));
  const r = req(40);
  const ev = evaluate(facts, r, NOW);
  assert.equal(ev.kind, "feasible");
  return { facts, r, plan: (ev as Extract<Evaluation, { kind: "feasible" }>).plan };
}
const clone = <T>(x: T): T => structuredClone(x);
const rejects = (bad: string[], why: RegExp) => assert.ok(bad.some((b) => why.test(b)), `expected /${why.source}/ in ${JSON.stringify(bad)}`);

test("checker rejects corrupted plans", () => {
  const { facts, r, plan } = feasiblePlan();
  assert.deepEqual(checkPlan(facts, r, plan, NOW), []);

  let p = clone(plan);
  p.production.find((x) => x.makerId === "sita")!.day = 2; // before her materials (day 5)
  rejects(checkPlan(facts, r, p, NOW), /before her materials/);

  p = clone(plan);
  p.production[0].pieces += 1;
  rejects(checkPlan(facts, r, p, NOW), /over capacity|produced/);

  p = clone(plan);
  p.finishing = [{ day: 0, pieces: 3 }, ...p.finishing.slice(1)]; // finished before anything was made
  rejects(checkPlan(facts, r, p, NOW), /made in time|finished/);

  p = clone(plan);
  p.finishing.push({ day: 26, pieces: 1 }); // after the last finishing day
  rejects(checkPlan(facts, r, p, NOW), /after the last finishing day/);

  p = clone(plan);
  p.money.perMaker[0].payInr -= 1;
  rejects(checkPlan(facts, r, p, NOW), /pay/);

  p = clone(plan);
  p.money.priceUsdCents += 1;
  rejects(checkPlan(facts, r, p, NOW), /not the lowest/);

  p = clone(plan);
  p.money.priceUsdCents -= 1;
  rejects(checkPlan(facts, r, p, NOW), /does not cover/);

  const changed = clone(facts);
  changed.makers[0].askInrPerPiece.value += 10;
  rejects(checkPlan(changed, r, plan, NOW), /different facts/);
});

test("checker rejects a plan that breaks a maker's other promise or her limit", () => {
  const { facts, r, plan } = feasiblePlan();
  const promised = clone(facts);
  promised.makers[0].commitments.value = [{ ref: "shop", pieces: 20, dueDay: 25 }]; // meera's days are now spoken for
  rejects(checkPlan(promised, r, plan, NOW), /promises no longer fit|different facts/);
  const limited = clone(facts);
  limited.makers[0].maxPieces = { value: 5, prov: limited.makers[0].askInrPerPiece.prov };
  rejects(checkPlan(limited, r, plan, NOW), /above her limit|different facts/);
});

test("checker rejects corrupted refusals and optimality claims", () => {
  const fin = Array.from({ length: H }, (_, t) => (t >= 10 ? 3 : 0));
  const facts = base(fin);
  const r = req(60, 28);
  const ev = evaluate(facts, r, NOW);
  assert.equal(ev.kind, "infeasible_capacity");
  if (ev.kind !== "infeasible_capacity") return;
  assert.deepEqual(checkRefusal(facts, r, ev.cut, NOW), []);

  const lie = clone(ev.cut);
  lie.bound = 30; // claims a smaller bound than the facts give
  rejects(checkRefusal(facts, r, lie, NOW), /≠ recomputed/);

  // A valid cut can still be too weak to prove the refusal: τ past the last finishing day
  // and u = H count every maker's whole capacity, far above 60.
  const weak = clone(ev.cut);
  weak.tau = 24;
  weak.makers = weak.makers.map((m) => ({ ...m, u: H }));
  weak.bound = 0;
  rejects(checkRefusal(facts, r, weak, NOW), /does not rule out/);

  // Asking for 40 when 42 is possible: the true minimum cut does not refuse it.
  rejects(checkRefusal(facts, { ...r, quantity: 40 }, ev.cut, NOW), /does not rule out/);

  const omit = clone(ev.cut);
  omit.makers = omit.makers.filter((m) => m.makerId !== "rani");
  rejects(checkRefusal(facts, r, omit, NOW), /omits rani/);

  // optimality: a plan that uses the expensive maker while a cheaper one has room
  const { facts: f2, r: r2, plan } = feasiblePlan();
  const okEv = evaluate(f2, r2, NOW) as Extract<Evaluation, { kind: "feasible" }>;
  assert.deepEqual(checkOptimality(f2, plan, okEv.optimality, NOW), []);
  const pricier = clone(plan);
  const s = pricier.production.find((x) => x.makerId === "sita")!;
  s.pieces -= 1;
  if (s.pieces === 0) pricier.production.splice(pricier.production.indexOf(s), 1);
  pricier.production.push({ makerId: "rani", day: 1, pieces: 1 });
  pricier.money.perMaker = pricier.money.perMaker.map((m) => (m.makerId === "sita" ? { ...m, pieces: m.pieces - 1, payInr: m.payInr - 900 } : m));
  pricier.money.perMaker.push({ makerId: "rani", pieces: 1, payInr: 1000 });
  rejects(checkOptimality(f2, pricier, okEv.optimality, NOW), /cheaper makers/);
});

test("reservations: two orders cannot both book the same finishing days", () => {
  const facts = base(daily(2, H));
  const first = evaluate(facts, req(40), NOW);
  assert.equal(first.kind, "feasible");
  if (first.kind !== "feasible") return;
  const reserved: CollectiveFacts = {
    ...facts,
    reservations: [{ planId: "order-1", production: first.plan.production, finishing: first.plan.finishing }],
  };
  const second = verified(reserved, req(40));
  assert.notEqual(second.kind, "feasible", "the capacity is taken");
  // and the first plan, replayed on top of its own reservation, is rejected as double-booking
  rejects(checkPlan(reserved, req(40), { ...first.plan, factsHash: "" }, NOW), /over capacity|different facts/);
});

test("a maker who withdraws is never silently replaced in an old plan", () => {
  const { facts, r, plan } = feasiblePlan();
  const withdrawn = clone(facts);
  withdrawn.makers[1].capable.value = false; // sita declines
  rejects(checkPlan(withdrawn, r, plan, NOW), /sita has not confirmed|different facts/);
  const replan = verified(withdrawn, r);
  assert.equal(replan.kind, "feasible");
  if (replan.kind === "feasible") assert.ok(!replan.plan.production.some((p) => p.makerId === "sita"));
});

test("single maker: the planner reproduces today's quote capacity (weekly rate, backlog first)", () => {
  const now = new Date("2026-11-06T09:00:00Z");
  let compared = 0;
  for (const ppw of [1, 2, 3, 4, 5, 7, 9, 12])
    for (const backlog of [0, 3, 6, 15])
      for (const ship of [3, 10])
        for (const offset of [5, 14, 24, 34, 60]) {
          const deadline = new Date(Date.UTC(2026, 10, 6 + offset));
          const old = maxQuantityByDeadline(now, deadline, backlog, ppw, ship);
          const facts = collective({
            H: 200,
            fin: daily(1000, 200),
            lag: 0,
            transit: ship,
            makers: [maker("solo", { cap: weeklyToDaily(ppw, 200), commits: backlog ? [{ ref: "backlog", pieces: backlog, dueDay: null }] : [] })],
          });
          const deliveryDay = dayIndex(facts.startDate, deadline.toISOString());
          const ev = evaluate(facts, { quantity: 10_000, deliveryDay, budgetUsdCents: null }, now);
          const max = ev.kind === "infeasible_capacity" ? ev.maxQuantity : -1;
          if (ppw <= 7) assert.equal(max, old, `ppw ${ppw} backlog ${backlog} ship ${ship} +${offset}d`);
          else assert.ok(max >= old && max - old <= 1, `whole-piece days can add at most one piece (ppw ${ppw})`);
          compared++;
        }
  assert.equal(compared, 320);
});
