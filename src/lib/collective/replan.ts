import { checkPlan } from "@/lib/planner/check";
import { planKeeping, type Keep } from "@/lib/planner/solve";
import { dayIndex, type CollectiveFacts, type OrderRequest, type Plan } from "@/lib/planner/model";
import { hashOf, partTerms, type Product } from "./terms";

/**
 * Replanning that preserves agreements (docs/direction.md §D).
 *
 * Objective, in order: (1) keep the greatest number of complete, identical accepted parts
 * — same days, pieces, pay, finishing end and dispatch date, i.e. the same terms hash;
 * (2) among plans keeping equally many, the lowest price. Every M1 constraint and the
 * buyer's budget apply.
 *
 * Checked independently: the plan (check.ts) and, for every kept part, that the new terms
 * hash equals the accepted one. Exhaustive search, NOT independently certified: that no
 * larger set can be kept. Beyond EXACT_LIMIT accepted parts a greedy search is used and
 * the result is labelled heuristic.
 */

export const EXACT_LIMIT = 8;

export type AcceptedPart = { memberId: string; name: string; termsHash: string; schedule: { date: string; pieces: number }[] };
export type TermsCtx = { collective: string; orderRef: string; product: Product; details: string | null; detailsHi?: string | null; transitDays: number };
export type Attempt = { names: string[]; reason: "kept" | "capacity" | "budget" | "facts" | "terms_changed" | "checker" | "input" };

export type KeepOption = {
  kept: { memberId: string; name: string }[];
  /** Makers whose part is new or changed in this plan: they are asked again. */
  askedAgain: { memberId: string; name: string }[];
  acceptedCount: number;
  plan: Plan;
  priceUsdCents: number;
  /** The cheapest fresh plan (the planner's primary answer) and how many agreed parts it happens to keep. */
  fresh: { priceUsdCents: number; keeps: number; askedAgain: number } | null;
  premiumUsdCents: number | null;
  search: "exhaustive" | "heuristic";
  /** Larger sets that were tried and why each failed (exhaustive: every one of them). */
  failed: Attempt[];
};

function subsets<T>(xs: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (xs.length < k) return [];
  const [head, ...rest] = xs;
  return [...subsets(rest, k - 1).map((s) => [head, ...s]), ...subsets(rest, k)];
}

/** Parts of `plan` identical to accepted ones (same terms hash). */
export function keptBy(plan: Plan, startDate: string, accepted: AcceptedPart[], ctx: TermsCtx): AcceptedPart[] {
  return accepted.filter((a) => {
    const t = partTerms(plan, startDate, a.memberId, ctx);
    return !!t && hashOf(t) === a.termsHash;
  });
}

export function keepAgreedOption(
  facts: CollectiveFacts,
  request: OrderRequest,
  now: Date,
  accepted: AcceptedPart[],
  ctx: TermsCtx,
  fresh: Plan | null,
): { option: KeepOption | null; failed: Attempt[]; search: "exhaustive" | "heuristic" } {
  const startDate = facts.startDate;
  const sorted = [...accepted].sort((a, b) => a.memberId.localeCompare(b.memberId));
  const failed: Attempt[] = [];

  const attempt = (set: AcceptedPart[]): { plan: Plan } | { reason: Attempt["reason"] } => {
    const keep: Keep[] = set.map((a) => ({ makerId: a.memberId, production: a.schedule.map((s) => ({ day: dayIndex(startDate, s.date), pieces: s.pieces })) }));
    const r = planKeeping(facts, request, now, keep);
    if (r.kind === "fail") return { reason: r.reason };
    if (checkPlan(facts, request, r.plan, now).length) return { reason: "checker" };
    if (keptBy(r.plan, startDate, set, ctx).length !== set.length) return { reason: "terms_changed" };
    return { plan: r.plan };
  };

  let best: { set: AcceptedPart[]; plan: Plan } | null = null;
  let search: "exhaustive" | "heuristic" = "exhaustive";
  if (sorted.length <= EXACT_LIMIT) {
    for (let k = sorted.length; k >= 1 && !best; k--) {
      for (const set of subsets(sorted, k)) {
        const r = attempt(set);
        if ("plan" in r) {
          if (!best || r.plan.money.priceUsdCents < best.plan.money.priceUsdCents) best = { set, plan: r.plan };
        } else failed.push({ names: set.map((a) => a.name), reason: r.reason });
      }
    }
  } else {
    search = "heuristic";
    let set = sorted;
    while (set.length && !best) {
      const r = attempt(set);
      if ("plan" in r) {
        best = { set, plan: r.plan };
        break;
      }
      failed.push({ names: set.map((a) => a.name), reason: r.reason });
      // Drop the part whose removal works and is cheapest; otherwise the largest part.
      let next: { set: AcceptedPart[]; plan: Plan } | null = null;
      for (const drop of set) {
        const smaller = set.filter((a) => a !== drop);
        if (!smaller.length) continue;
        const s = attempt(smaller);
        if ("plan" in s && (!next || s.plan.money.priceUsdCents < next.plan.money.priceUsdCents)) next = { set: smaller, plan: s.plan };
      }
      if (next) best = next;
      else {
        const size = (a: AcceptedPart) => a.schedule.reduce((x, s) => x + s.pieces, 0);
        const largest = set.reduce((m, a) => (size(a) > size(m) ? a : m));
        set = set.filter((a) => a !== largest);
      }
    }
  }
  if (!best) return { option: null, failed, search };

  const producing = [...new Set(best.plan.production.map((p) => p.makerId))];
  const keptIds = new Set(best.set.map((a) => a.memberId));
  const freshKept = fresh ? keptBy(fresh, startDate, sorted, ctx) : [];
  const freshAsked = fresh ? new Set(fresh.production.map((p) => p.makerId)).size - freshKept.length : 0;
  const names = new Map(facts.makers.map((m) => [m.id, m.name]));
  return {
    option: {
      kept: best.set.map((a) => ({ memberId: a.memberId, name: a.name })),
      askedAgain: producing.filter((id) => !keptIds.has(id)).map((id) => ({ memberId: id, name: names.get(id) ?? "?" })),
      acceptedCount: sorted.length,
      plan: best.plan,
      priceUsdCents: best.plan.money.priceUsdCents,
      fresh: fresh ? { priceUsdCents: fresh.money.priceUsdCents, keeps: freshKept.length, askedAgain: freshAsked } : null,
      premiumUsdCents: fresh ? best.plan.money.priceUsdCents - fresh.money.priceUsdCents : null,
      search,
      failed: failed.filter((f) => f.names.length > best!.set.length),
    },
    failed,
    search,
  };
}
