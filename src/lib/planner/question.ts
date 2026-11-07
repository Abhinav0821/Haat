import { evaluate } from "./solve";
import { withReadyDay, type CollectiveFacts, type DecidingQuestion, type Evaluation, type OrderRequest, type ThresholdRefusal } from "./model";

/**
 * Extension M1-Q1, solver side (docs/planner-model.md §8). Scope: the M1 answer is
 * "unresolved" ONLY because one capable maker's materials-ready date is unknown; every
 * other fact is present, current and consistent, and the date is inside the horizon.
 *
 * Under M1 a later materials date only removes production days, so the set of feasible
 * plans shrinks and the minimum price can only rise: "works within the budget" is
 * monotone in her date. The latest working date is found by binary search; the checker
 * (check.ts → checkQuestion) verifies the plan at that date and the refusal the day after.
 */

const TOLERATED = new Set(["excluded", "estimate"]);

export function decidingQuestion(facts: CollectiveFacts, request: OrderRequest, now: Date, ev: Evaluation = evaluate(facts, request, now)): DecidingQuestion | null {
  if (ev.kind !== "unresolved") return null;
  const unknown = facts.makers.filter((m) => m.capable.value && m.materialsReadyDay === null);
  if (unknown.length !== 1) return null;
  const id = unknown[0].id;
  const blocking = ev.issues.filter((i) => !TOLERATED.has(i.code));
  const onlyHerDate = blocking.every((i) => (i.code === "missing" && i.fact === "materialsReadyDay" && i.makerId === id) || (i.code === "missing" && i.fact === "minimum_price"));
  if (!onlyHerDate || !blocking.some((i) => i.fact === "materialsReadyDay")) return null;

  const H = facts.horizonDays;
  const at = (day: number) => evaluate(withReadyDay(facts, id, day), request, now);
  const refusal = (e: Evaluation): ThresholdRefusal | null =>
    e.kind === "infeasible_capacity" ? { kind: "capacity", cut: e.cut } : e.kind === "infeasible_budget" && e.certified ? { kind: "budget", plan: e.plan, optimality: e.optimality } : null;

  const first = at(0);
  if (first.kind !== "feasible") {
    const r = refusal(first);
    return r ? { kind: "no_even_if_ready", makerId: id, refusal: r } : null;
  }
  if (at(H).kind === "feasible") return null; // works without her: M1 would not have been unresolved
  let lo = 0; // works
  let hi = H; // doesn't
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (at(mid).kind === "feasible") lo = mid;
    else hi = mid;
  }
  const yes = at(lo);
  const no = refusal(at(lo + 1));
  if (yes.kind !== "feasible" || !no) return null;
  return { kind: "threshold", makerId: id, lastDay: lo, plan: yes.plan, refusal: no };
}
