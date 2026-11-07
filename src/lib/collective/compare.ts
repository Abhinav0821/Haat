import { evaluate } from "@/lib/planner/solve";
import { checkEvaluation } from "@/lib/planner/check";
import { dayDate, type CollectiveFacts, type Evaluation, type OrderRequest } from "@/lib/planner/model";
import type { Words } from "./explain";

/**
 * Individual versus collective (docs/direction.md §B). The same planner and the same
 * independent checker answer the request for each maker alone and for the group, on the
 * SAME facts, reservations, deadline and cost assumptions: only the other makers are
 * marked unavailable.
 *
 * Privacy: `alone` (names, capacities, prices) is for the coordinator only. Buyers and
 * agents get `buyerSentence`, an aggregate claim made only when every standalone answer
 * is a checked refusal and the group answer is a checked yes.
 */

export type AloneResult = { makerId: string; name: string; kind: Evaluation["kind"]; checked: boolean; maxQuantity: number | null; priceUsdCents: number | null; words: Words };
export type Comparison = { alone: AloneResult[]; groupYes: boolean; noneAloneButTogether: boolean };

export const BUYER_SENTENCE: Words = {
  en: "No individual maker can fulfil this request within its date and budget. The collective can.",
  hi: "कोई एक कारीगर अकेले यह ऑर्डर इस तारीख़ और बजट में पूरा नहीं कर सकती। सब मिलकर कर सकती हैं।",
};

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const enDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const hiDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("hi-IN", { day: "numeric", month: "long", timeZone: "UTC" });

/** The facts with only `makerId` available. Nothing else changes. */
export function aloneFacts(facts: CollectiveFacts, makerId: string): CollectiveFacts {
  return {
    ...facts,
    makers: facts.makers.map((m) =>
      m.id === makerId || !m.capable.value ? m : { ...m, capable: { value: false, prov: { source: "system", by: "comparison: this maker alone", at: m.capable.prov.at } } },
    ),
  };
}

function words(ev: Evaluation, request: OrderRequest, facts: CollectiveFacts, name: string): Words {
  const due = dayDate(facts.startDate, request.deliveryDay);
  switch (ev.kind) {
    case "feasible":
      return { en: `${name} alone could deliver all ${request.quantity} by ${enDay(due)} for ${usd(ev.plan.money.priceUsdCents)}.`, hi: `${name} अकेले सभी ${request.quantity} पीस ${hiDay(due)} तक ${usd(ev.plan.money.priceUsdCents)} में दे सकती हैं।` };
    case "infeasible_capacity":
      return { en: `${name} alone: at most ${ev.maxQuantity} of ${request.quantity} by ${enDay(due)}.`, hi: `${name} अकेले: ${hiDay(due)} तक ${request.quantity} में से ज़्यादा से ज़्यादा ${ev.maxQuantity}।` };
    case "infeasible_budget":
      return {
        en: `${name} alone: all ${request.quantity} by ${enDay(due)} are possible, but the lowest price, ${usd(ev.plan.money.priceUsdCents)}, is above the budget of ${usd(ev.budgetUsdCents)}.`,
        hi: `${name} अकेले: सभी ${request.quantity} पीस ${hiDay(due)} तक बन सकते हैं, पर सबसे कम दाम ${usd(ev.plan.money.priceUsdCents)} बजट ${usd(ev.budgetUsdCents)} से ज़्यादा है।`,
      };
    case "unresolved": {
      const first = ev.issues.find((i) => i.code !== "excluded" && i.code !== "estimate");
      return { en: `${name} alone: can't tell yet${first ? ` (${first.en})` : ""}.`, hi: `${name} अकेले: अभी तय नहीं${first ? ` (${first.hi})` : ""}।` };
    }
  }
}

/** `group` is the group's evaluation and checker problems on exactly these facts. */
export function aloneVsTogether(facts: CollectiveFacts, request: OrderRequest, now: Date, group: { evaluation: Evaluation; problems: string[] }): Comparison {
  const capable = facts.makers.filter((m) => m.capable.value);
  const alone = capable.map((m) => {
    const f = aloneFacts(facts, m.id);
    const ev = evaluate(f, request, now);
    const problems = ev.kind === "unresolved" ? ["unresolved"] : checkEvaluation(f, request, ev, now);
    return {
      makerId: m.id,
      name: m.name,
      kind: ev.kind,
      checked: ev.kind !== "unresolved" && problems.length === 0,
      maxQuantity: ev.kind === "infeasible_capacity" ? ev.maxQuantity : ev.kind === "unresolved" ? null : request.quantity,
      priceUsdCents: ev.kind === "feasible" || ev.kind === "infeasible_budget" ? ev.plan.money.priceUsdCents : null,
      words: words(ev, request, facts, m.name),
    };
  });
  const groupYes = group.evaluation.kind === "feasible" && group.problems.length === 0;
  const noneAloneButTogether =
    groupYes && alone.length >= 2 && alone.every((a) => a.checked && (a.kind === "infeasible_capacity" || a.kind === "infeasible_budget"));
  return { alone, groupYes, noneAloneButTogether };
}
