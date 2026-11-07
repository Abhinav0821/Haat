import { factsHash, PLANNER_MODEL, type CollectiveFacts, type FinishingEntry, type Money, type OrderRequest, type Plan, type ProductionEntry } from "@/lib/planner/model";
import { evaluate, feeUsdCents, priceFor } from "@/lib/planner/solve";
import { maxQuantityByDeadline } from "@/lib/custom/quote";
import { NOW, START } from "./scenarios";

/**
 * The approaches compared. Each gets the SAME facts and request and returns an Answer.
 * Plans are judged only by the independent checker (src/lib/planner/check.ts), never by
 * the approach that made them.
 */

export type Answer =
  | { kind: "yes"; plan: Plan; statedPriceUsdCents?: number | null; note?: string }
  /** Old Haat: "maker X alone can do it" — a claim with no day-by-day plan. */
  | { kind: "claim_yes"; makerId: string; priceUsdCents: number }
  | { kind: "no_capacity"; maxQuantity: number | null }
  | { kind: "no_budget"; priceUsdCents: number | null }
  | { kind: "undecided"; reason: string }
  | { kind: "error"; reason: string };

export const lastFinishOf = (f: CollectiveFacts, deliveryDay: number) => deliveryDay - f.transitDays.value - f.packDays - 1;

/** Money for a production schedule, by M1's cost-plus rule (the same arithmetic the checker recomputes). */
export function moneyFor(f: CollectiveFacts, production: ProductionEntry[], quantity: number): Money {
  const pieces = new Map<string, number>();
  for (const p of production) pieces.set(p.makerId, (pieces.get(p.makerId) ?? 0) + p.pieces);
  const perMaker = f.makers.filter((m) => pieces.has(m.id)).map((m) => ({ makerId: m.id, pieces: pieces.get(m.id)!, payInr: m.askInrPerPiece.value * pieces.get(m.id)! }));
  const c = f.costs;
  const makersInr = perMaker.reduce((s, x) => s + x.payInr, 0);
  const totalCostInr = makersInr + (c.finishingInrPerPiece + c.packagingInrPerPiece + c.collectionInrPerPiece + c.chargeInrPerPiece) * quantity + c.shippingInrPerOrder;
  const priceUsdCents = priceFor(totalCostInr, f.fee, f.inrPerUsd.value);
  return {
    perMaker,
    makersInr,
    finishingInr: c.finishingInrPerPiece * quantity,
    packagingInr: c.packagingInrPerPiece * quantity,
    collectionInr: c.collectionInrPerPiece * quantity,
    chargeInr: c.chargeInrPerPiece * quantity,
    shippingInr: c.shippingInrPerOrder,
    totalCostInr,
    priceUsdCents,
    estFeeUsdCents: feeUsdCents(priceUsdCents, f.fee),
  };
}

/** Wrap a schedule as an M1 plan for the checker. The quantity is what the schedule finishes. */
export function asPlan(f: CollectiveFacts, request: OrderRequest, production: ProductionEntry[], finishing: FinishingEntry[]): Plan {
  const quantity = finishing.reduce((s, x) => s + x.pieces, 0);
  return {
    model: PLANNER_MODEL,
    factsHash: factsHash(f, request),
    quantity,
    deliveryDay: request.deliveryDay,
    lastFinishDay: lastFinishOf(f, request.deliveryDay),
    production,
    finishing,
    money: moneyFor(f, production, quantity),
  };
}

// ── 1. The planner (model M1) ────────────────────────────────────────────────

export function planner(f: CollectiveFacts, request: OrderRequest): Answer {
  const ev = evaluate(f, request, NOW);
  switch (ev.kind) {
    case "feasible":
      return { kind: "yes", plan: ev.plan };
    case "infeasible_capacity":
      return { kind: "no_capacity", maxQuantity: ev.maxQuantity };
    case "infeasible_budget":
      return { kind: "no_budget", priceUsdCents: ev.plan.money.priceUsdCents };
    default:
      return { kind: "undecided", reason: ev.issues.map((i) => i.en).join(" ") };
  }
}

// ── 2. Rule-based split: what a careful coordinator does in a spreadsheet ─────

/**
 * Each maker's own promises go on her earliest days first. Makers are filled in order
 * (cheapest first; if that misses the date, earliest-available first), each on her
 * earliest free days, up to her cap. Finishing then takes pieces first-in first-out
 * as soon as they have rested a day. Makers whose materials date is unknown are left
 * out (a careful coordinator doesn't count on them).
 */
export function ruleBasedGreedy(f: CollectiveFacts, request: OrderRequest): Answer {
  const L = lastFinishOf(f, request.deliveryDay);
  if (L < 0) return { kind: "no_capacity", maxQuantity: 0 };
  const usable = f.makers.filter((m) => m.capable.value && m.materialsReadyDay !== null);
  const orders = [
    [...usable].sort((a, b) => a.askInrPerPiece.value - b.askInrPerPiece.value),
    [...usable].sort((a, b) => a.materialsReadyDay!.value - b.materialsReadyDay!.value || a.askInrPerPiece.value - b.askInrPerPiece.value),
  ];
  let best = 0;
  for (const order of orders) {
    const production: ProductionEntry[] = [];
    let need = request.quantity;
    for (const m of order) {
      const free = m.dailyCapacity.value.slice();
      let promised = m.commitments.value.reduce((s, c) => s + c.pieces, 0);
      for (let t = 0; t < free.length && promised > 0; t++) {
        const take = Math.min(free[t], promised);
        free[t] -= take;
        promised -= take;
      }
      let mine = 0;
      for (let t = m.materialsReadyDay!.value; t <= L - f.lagDays && t < free.length && need > 0; t++) {
        const room = m.maxPieces ? m.maxPieces.value - mine : Infinity;
        const take = Math.min(free[t], need, room);
        if (take > 0) {
          production.push({ makerId: m.id, day: t, pieces: take });
          mine += take;
          need -= take;
        }
      }
    }
    const finishing: FinishingEntry[] = [];
    let finished = 0;
    for (let t = 0; t <= Math.min(L, f.horizonDays - 1); t++) {
      const ready = production.filter((p) => p.day <= t - f.lagDays).reduce((s, p) => s + p.pieces, 0) - finished;
      const take = Math.min(f.finishingPerDay.value[t], ready, request.quantity - finished);
      if (take > 0) {
        finishing.push({ day: t, pieces: take });
        finished += take;
      }
    }
    best = Math.max(best, finished);
    if (finished === request.quantity) {
      const plan = asPlan(f, request, production, finishing);
      if (request.budgetUsdCents !== null && plan.money.priceUsdCents > request.budgetUsdCents) return { kind: "no_budget", priceUsdCents: plan.money.priceUsdCents };
      return { kind: "yes", plan };
    }
  }
  return { kind: "no_capacity", maxQuantity: best };
}

/** Same allocation heuristic, with explicit missing/inconsistent-fact handling.
 * No solver or optimality oracle is used. A loose optimistic bound can still prove
 * a capacity refusal despite an unknown materials date; otherwise ask for facts.
 */
export function ruleBased(f: CollectiveFacts, request: OrderRequest): Answer {
  const answer = ruleBasedGreedy(f, request);
  const makers = f.makers.filter((m) => m.capable.value);
  const inconsistent = new Set(makers.filter((m) => {
    const dueDates = [...new Set(m.commitments.value.map((c) => c.dueDay).filter((d): d is number => d !== null))];
    return dueDates.some((day) => m.commitments.value.filter((c) => c.dueDay !== null && c.dueDay <= day).reduce((n, c) => n + c.pieces, 0) > m.dailyCapacity.value.slice(0, day + 1).reduce((n, x) => n + x, 0));
  }).map((m) => m.id));
  const needsConfirmation: Answer = { kind: "undecided", reason: "Existing promises exceed a maker's capacity before their due date; confirm her facts." };
  if (answer.kind === "yes") return answer.plan.production.some((p) => inconsistent.has(p.makerId)) ? needsConfirmation : answer;
  if (inconsistent.size) return needsConfirmation;
  if (!makers.some((m) => m.materialsReadyDay === null)) return answer;
  const L = Math.min(lastFinishOf(f, request.deliveryDay), f.horizonDays - 1);
  // Relax promises, materials for unknown makers, and finishing timing. This is an
  // upper bound, not a feasible schedule or an exact maximum.
  const upperProduction = makers.reduce((n, m) => n + Math.min(m.maxPieces?.value ?? Infinity, m.dailyCapacity.value.slice(Math.max(0, m.materialsReadyDay?.value ?? 0), Math.max(0, L - f.lagDays + 1)).reduce((a, b) => a + b, 0)), 0);
  const upperFinishing = f.finishingPerDay.value.slice(0, Math.max(0, L + 1)).reduce((n, x) => n + x, 0);
  if (answer.kind === "no_capacity" && Math.min(upperProduction, upperFinishing) < request.quantity) return answer;
  return { kind: "undecided", reason: "The answer may change when the missing materials date is known." };
}

// ── 3. Old Haat: the single-maker quote rule used before the planner ──────────

/**
 * Before the planner, Haat quoted one maker at a time: her weekly rate, minus work
 * already promised, over the working days before the deadline less courier days
 * (src/lib/custom/quote.ts). It can't combine makers and doesn't see the shared
 * finishing table, weekday patterns, materials dates or when promises are due.
 * Price: the same cost-plus rule as the planner, for that one maker.
 */
export function oldHaat(f: CollectiveFacts, request: OrderRequest): Answer {
  const deadline = new Date(Date.parse(`${START}T00:00:00Z`) + request.deliveryDay * 86_400_000);
  const quotes = f.makers
    .filter((m) => m.capable.value)
    .map((m) => {
      const perWeek = m.dailyCapacity.value.slice(0, 7).reduce((s, x) => s + x, 0);
      const backlog = m.commitments.value.reduce((s, c) => s + c.pieces, 0);
      const capped = (q: number) => (m.maxPieces ? Math.min(q, m.maxPieces.value) : q);
      const most = perWeek > 0 ? capped(maxQuantityByDeadline(NOW, deadline, backlog, perWeek, f.transitDays.value)) : 0;
      const cost = m.askInrPerPiece.value * request.quantity;
      const c = f.costs;
      const total = cost + (c.finishingInrPerPiece + c.packagingInrPerPiece + c.collectionInrPerPiece + c.chargeInrPerPiece) * request.quantity + c.shippingInrPerOrder;
      return { m, most, price: priceFor(total, f.fee, f.inrPerUsd.value) };
    });
  const able = quotes.filter((q) => q.most >= request.quantity).sort((a, b) => a.price - b.price);
  if (!able.length) return { kind: "no_capacity", maxQuantity: Math.max(0, ...quotes.map((q) => q.most)) };
  const pick = able[0];
  if (request.budgetUsdCents !== null && pick.price > request.budgetUsdCents) return { kind: "no_budget", priceUsdCents: pick.price };
  return { kind: "claim_yes", makerId: pick.m.id, priceUsdCents: pick.price };
}
