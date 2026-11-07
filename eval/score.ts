import { checkPlan } from "@/lib/planner/check";
import { evaluate } from "@/lib/planner/solve";
import type { CollectiveFacts, Evaluation } from "@/lib/planner/model";
import type { Answer } from "./approaches";
import { NOW, type Scenario } from "./scenarios";

export type Outcome =
  | "correct_yes" // a valid schedule (checker-accepted), within budget
  | "unsafe_yes" // promised something the checker rejects, or that no maker set can deliver
  | "over_budget_yes" // a valid schedule, but above the buyer's budget
  | "missed" // said no / can't decide when a valid answer exists
  | "correct_no" // the right kind of no
  | "wrong_kind" // a no of the wrong kind (e.g. "impossible" when it's really "not decided yet", or capacity vs budget)
  | "correct_undecided"
  | "unsupported" // the approach can't express this case (reported separately, not as a mistake)
  | "error"; // the approach produced no answer (e.g. the model call failed)

export type Score = {
  outcome: Outcome;
  /** Checker messages for a rejected schedule (first few). */
  violations: string[];
  /** Coarse categories of what was violated. */
  categories: string[];
  /** Price above the certified minimum, for valid yeses on feasible cases (fraction, 0 = optimal). */
  priceGap: number | null;
  /** For a capacity "no": the claimed largest quantity vs the true one. */
  maxClaim: "exact" | "under" | "over" | "none" | null;
  /** For model answers with a stated price: did it equal the correct price of its own schedule? */
  statedPriceRight: boolean | null;
  /** A valid answer that disagrees with the planner's truth — would indicate a planner bug. */
  truthDisagreement: boolean;
};

const CATEGORIES: [RegExp, string][] = [
  [/^finishing over capacity/, "finishing table over capacity"],
  [/ is over capacity on day/, "maker over capacity"],
  [/finished but only .* made in time/, "finished before made (+ rest day)"],
  [/before her materials/, "before materials arrive"],
  [/other promises/, "breaks her other promises"],
  [/above her limit/, "above her cap"],
  [/after the last finishing day|outside the horizon/, "misses the date"],
  [/produced .* ≠ quantity|finished .* ≠ quantity|doesn't answer the request/, "wrong quantity"],
  [/missing, stale or inconsistent/, "relies on unknown facts"],
  [/unknown maker|non-positive|fractional/, "malformed schedule"],
];

export function categorise(problems: string[]): string[] {
  const out = new Set<string>();
  for (const p of problems) out.add(CATEGORIES.find(([re]) => re.test(p))?.[1] ?? "other");
  return [...out];
}

const base = (outcome: Outcome, extra: Partial<Score> = {}): Score => ({ outcome, violations: [], categories: [], priceGap: null, maxClaim: null, statedPriceRight: null, truthDisagreement: false, ...extra });

/** Facts where only one maker may produce (to check old Haat's single-maker claims). */
export function onlyMaker(f: CollectiveFacts, makerId: string): CollectiveFacts {
  return { ...f, makers: f.makers.map((m) => (m.id === makerId ? m : { ...m, capable: { ...m.capable, value: false } })) };
}

/** Could ANY single maker alone deliver it? (Old Haat can't combine makers.) */
export function singleMakerFeasible(s: Scenario, now = NOW): boolean {
  return s.facts.makers.some((m) => evaluate(onlyMaker(s.facts, m.id), s.request, now).kind === "feasible");
}

/** A right decision is separate from a usable answer with a correct quote/maximum. */
export const completeAnswerCorrect = (s: Score) => s.outcome.startsWith("correct_") && s.statedPriceRight !== false && (s.priceGap === null || s.priceGap === 0) && (s.maxClaim === null || s.maxClaim === "exact");

export function score(s: Scenario, truthEv: Evaluation, a: Answer, opts: { singleMakerOnly?: boolean; now?: Date } = {}): Score {
  const now = opts.now ?? NOW;
  const truth = s.truth;
  const minPrice = truthEv.kind === "feasible" && truthEv.certified ? truthEv.plan.money.priceUsdCents : null;
  const trueMax = truthEv.kind === "infeasible_capacity" ? truthEv.maxQuantity : null;
  const missedOrUnsupported = (): Score => (opts.singleMakerOnly && truth === "yes" && !singleMakerFeasible(s, now) ? base("unsupported") : base("missed"));

  switch (a.kind) {
    case "error":
      return base("error", { violations: [a.reason] });
    case "yes": {
      const problems = checkPlan(s.facts, s.request, a.plan, now);
      const stated = "statedPriceUsdCents" in a ? a.statedPriceUsdCents === a.plan.money.priceUsdCents : true;
      if (problems.length) return base("unsafe_yes", { violations: problems.slice(0, 5), categories: categorise(problems), statedPriceRight: stated });
      if (s.request.budgetUsdCents !== null && a.plan.money.priceUsdCents > s.request.budgetUsdCents) return base("over_budget_yes", { statedPriceRight: stated });
      return base("correct_yes", { priceGap: minPrice ? a.plan.money.priceUsdCents / minPrice - 1 : null, statedPriceRight: stated, truthDisagreement: truth !== "yes" });
    }
    case "claim_yes": {
      const alone = evaluate(onlyMaker(s.facts, a.makerId), { ...s.request, budgetUsdCents: null }, now);
      if (alone.kind !== "feasible") {
        const why = alone.kind === "infeasible_capacity" ? `she can make and finish at most ${alone.maxQuantity} by the date` : "it depends on facts that are unknown";
        const cats = alone.kind === "unresolved" ? ["relies on unknown facts"] : ["over-promise (one maker can't do it by the date)"];
        return base("unsafe_yes", { violations: [`${a.makerId} alone: ${why}`], categories: cats });
      }
      if (s.request.budgetUsdCents !== null && a.priceUsdCents > s.request.budgetUsdCents) return base("over_budget_yes");
      return base("correct_yes", { priceGap: minPrice ? a.priceUsdCents / minPrice - 1 : null, statedPriceRight: a.priceUsdCents === alone.plan.money.priceUsdCents, truthDisagreement: truth !== "yes" });
    }
    case "no_capacity": {
      if (truth === "yes") return missedOrUnsupported();
      if (opts.singleMakerOnly && truth === "undecided") return base("unsupported"); // it has no way to say "not decided yet"
      if (truth !== "no_capacity") return base("wrong_kind");
      const claim = a.maxQuantity;
      return base("correct_no", { maxClaim: claim === null ? "none" : claim === trueMax ? "exact" : claim < trueMax! ? "under" : "over" });
    }
    case "no_budget":
      if (truth === "yes") return missedOrUnsupported();
      if (opts.singleMakerOnly && truth === "undecided") return base("unsupported");
      return base(truth === "no_budget" ? "correct_no" : "wrong_kind", { statedPriceRight: truthEv.kind === "infeasible_budget" && a.priceUsdCents === truthEv.plan.money.priceUsdCents });
    case "undecided":
      if (truth === "yes") return missedOrUnsupported();
      return base(truth === "undecided" ? "correct_undecided" : "wrong_kind");
  }
}
