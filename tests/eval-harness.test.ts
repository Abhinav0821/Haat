import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { handcrafted, makeFacts, randomScenarios, truthOf, NOW } from "../eval/scenarios";
import { asPlan, oldHaat, planner, ruleBased } from "../eval/approaches";
import { score } from "../eval/score";
import { toAnswer } from "../eval/llm";
import { checkPlan } from "@/lib/planner/check";

const QUOTA = { yes: 16, no_capacity: 12, no_budget: 6, undecided: 6 };
const cases = () => [...handcrafted(), ...randomScenarios(20261108, QUOTA)];

test("scenarios are reproducible from the seed and fill every answer type", () => {
  const h = (xs: ReturnType<typeof cases>) => createHash("sha256").update(JSON.stringify(xs.map((s) => [s.facts, s.request, s.truth]))).digest("hex");
  assert.equal(h(cases()), h(cases()), "same seed → identical cases");
  assert.notEqual(h(randomScenarios(1, QUOTA)), h(randomScenarios(2, QUOTA)));
  const all = cases();
  for (const t of ["yes", "no_capacity", "no_budget", "undecided"] as const) assert.ok(all.filter((s) => s.truth === t).length >= QUOTA[t]);
});

test("every truth is the planner's answer accepted by the independent checker", () => {
  for (const s of cases()) assert.doesNotThrow(() => truthOf(s.facts, s.request), s.id);
});

test("the planner scores perfectly against its own checked truth (sanity, not evidence)", () => {
  for (const s of cases()) assert.match(score(s, truthOf(s.facts, s.request).ev, planner(s.facts, s.request)).outcome, /^correct_/, s.id);
});

test("whenever the rule-based split says yes, its schedule passes the checker", () => {
  for (const s of cases()) {
    const a = ruleBased(s.facts, s.request);
    if (a.kind === "yes") assert.deepEqual(checkPlan(s.facts, s.request, a.plan, NOW), [], s.id);
  }
});

test("a schedule that breaks a fact is scored unsafe, with the broken rule named", () => {
  const s = handcrafted().find((x) => x.id === "h2-cheap-maker-late")!;
  const { ev } = truthOf(s.facts, s.request);
  // Everything on day 0 from the late, cheap maker: before her materials, over capacity, finishing too early.
  const bad = asPlan(s.facts, s.request, [{ makerId: "Meera", day: 0, pieces: 40 }], [{ day: 1, pieces: 40 }]);
  const sc = score(s, ev, { kind: "yes", plan: bad });
  assert.equal(sc.outcome, "unsafe_yes");
  assert.ok(sc.categories.includes("before materials arrive"));
  assert.ok(sc.categories.includes("maker over capacity"));
  assert.ok(sc.categories.includes("finishing table over capacity"));
});

test("kinds of no are kept apart: capacity, budget and not-decided-yet", () => {
  const all = cases();
  const und = all.find((s) => s.truth === "undecided")!;
  const cap = all.find((s) => s.truth === "no_capacity")!;
  const bud = all.find((s) => s.truth === "no_budget")!;
  const ev = (s: typeof und) => truthOf(s.facts, s.request).ev;
  assert.equal(score(und, ev(und), { kind: "no_capacity", maxQuantity: 0 }).outcome, "wrong_kind", "'impossible' when it's really unknown");
  assert.equal(score(cap, ev(cap), { kind: "no_budget", priceUsdCents: 1 }).outcome, "wrong_kind");
  assert.equal(score(bud, ev(bud), { kind: "no_budget", priceUsdCents: 1 }).outcome, "correct_no");
  const trueMax = (ev(cap) as { maxQuantity: number }).maxQuantity;
  assert.equal(score(cap, ev(cap), { kind: "no_capacity", maxQuantity: trueMax + 1 }).maxClaim, "over");
});

test("old Haat's single-maker claims are checked against that maker alone, including the finishing table", () => {
  const s = handcrafted().find((x) => x.id === "h1-finishing-bottleneck")!;
  const a = oldHaat(s.facts, s.request);
  assert.equal(a.kind, "claim_yes", "the weekly-rate rule doesn't see the finishing table");
  assert.equal(score(s, truthOf(s.facts, s.request).ev, a, { singleMakerOnly: true }).outcome, "unsafe_yes");
});

test("a model answer is converted faithfully: its quantity is what it finishes, and its stated price is compared, not trusted", () => {
  const f = makeFacts([{ id: "A", week: [0, 5, 5, 5, 5, 5, 0], ready: 0, ask: 400 }], [0, 8, 8, 8, 8, 8, 0]);
  const request = { quantity: 10, deliveryDay: 20, budgetUsdCents: null };
  const raw = { decision: "yes" as const, production: [{ maker: "A", day: 0, pieces: 5 }, { maker: "A", day: 1, pieces: 4 }], finishing: [{ day: 2, pieces: 9 }], priceUsdCents: 1, maxQuantityByDate: null, reason: "" };
  const a = toAnswer(f, request, raw);
  assert.equal(a.kind, "yes");
  const sc = score({ id: "x", label: "", facts: f, request, truth: truthOf(f, request).truth }, truthOf(f, request).ev, a);
  assert.equal(sc.outcome, "unsafe_yes");
  assert.ok(sc.categories.includes("wrong quantity"));
  assert.equal(sc.statedPriceRight, false);
});
