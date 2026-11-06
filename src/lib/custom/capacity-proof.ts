import type { Economics } from "@/lib/economics";
import { evaluate } from "@/lib/planner/solve";
import { checkEvaluation } from "@/lib/planner/check";
import { dayDate, dayIndex, weeklyToDaily, type CollectiveFacts, type Evaluation, type OrderRequest } from "@/lib/planner/model";

/**
 * Single-maker adapter for the collective planner (model M1, docs/planner-model.md).
 *
 * A maker working alone is a collective of one: her weekly pace becomes whole-piece
 * days, work already booked is a promise due first-in-first-out, and she finishes her
 * own pieces (no shared stage, no lag). The planner answers the CAPACITY questions —
 * most pieces by a date, earliest date for all of them — and the independent checker
 * must accept the answer before it is used. Prices stay with the earnings calculator
 * (economics.ts), which models her own costs; the collective money model is not used.
 *
 * Assumptions of this adapter (stated, not hidden): materials are in hand today (the
 * single-maker rules have no materials date), and her saved rules are current (she
 * edits them herself), so no staleness applies.
 */

const HORIZON = 366;

export type CapacityProof =
  | {
      verified: true;
      quantity: number;
      /** Against the buyer's date (null when no date was given). `max` is exact only when `fits` is false. */
      byDeadline: null | { date: string; fits: boolean; max: number; lastWorkDay: string; capacity: number; booked: number };
      /** Earliest ready/delivery dates for the full quantity, or null if not within a year. */
      earliest: { readyBy: string; delivery: string } | null;
    }
  | { verified: false; reason: string };

function facts(e: Economics, startDate: string, inrPerUsd: number): CollectiveFacts {
  const at = `${startDate}T00:00:00Z`;
  const sys = <T>(value: T) => ({ value, prov: { source: "system" as const, by: "saved rules", at } });
  return {
    startDate,
    horizonDays: HORIZON,
    finishingPerDay: sys(new Array(HORIZON).fill(10_000)),
    lagDays: 0,
    packDays: 0,
    transitDays: sys(e.shippingDays),
    costs: { finishingInrPerPiece: 0, packagingInrPerPiece: 0, collectionInrPerPiece: 0, chargeInrPerPiece: 0, shippingInrPerOrder: 0 },
    fee: { percent: 0, fixedUsdCents: 0 },
    inrPerUsd: sys(inrPerUsd),
    reservations: [],
    staleAfterDays: 0,
    makers: [
      {
        id: "self",
        name: "self",
        capable: sys(true),
        dailyCapacity: sys(weeklyToDaily(e.piecesPerWeek ?? 0, HORIZON)),
        materialsReadyDay: sys(0),
        commitments: sys(e.backlogPieces > 0 ? [{ ref: "booked", pieces: e.backlogPieces, dueDay: null }] : []),
        askInrPerPiece: sys(0),
        floorInrPerPiece: sys(0),
        maxPieces: null,
        fixedCostInr: 0,
      },
    ],
  };
}

/** Runs the planner, then the independent checker; anything it rejects is reported, never used. */
function verified(f: CollectiveFacts, r: OrderRequest, at: Date): Evaluation | string {
  const ev = evaluate(f, r, at);
  if (ev.kind === "unresolved") return ev.issues.map((i) => i.en).join(" ");
  const problems = checkEvaluation(f, r, ev, at);
  return problems.length ? `checker rejected: ${problems.slice(0, 3).join("; ")}` : ev;
}

export function capacityProof(e: Economics | null, quantity: number, deadline: string | null, now: Date, inrPerUsd: number): CapacityProof {
  if (!e?.piecesPerWeek) return { verified: false, reason: "weekly capacity not set" };
  if (!Number.isInteger(quantity) || quantity < 1) return { verified: false, reason: "invalid quantity" };
  const startDate = now.toISOString().slice(0, 10);
  // Facts are stamped at the start of today; the plan is evaluated as of now.
  const f = facts(e, startDate, inrPerUsd);

  // Earliest: ask for delivery "today", which is refused, and read the certified earliest date.
  const asap = verified(f, { quantity, deliveryDay: 0, budgetUsdCents: null }, now);
  if (typeof asap === "string") return { verified: false, reason: asap };
  let earliest: { readyBy: string; delivery: string } | null = null;
  if (asap.kind === "infeasible_capacity") {
    const ed = asap.alternatives.earliestDelivery;
    if (ed?.kind === "found") earliest = { readyBy: dayDate(startDate, ed.plan.lastFinishDay + 1), delivery: dayDate(startDate, ed.plan.deliveryDay) };
  } else return { verified: false, reason: "a same-day delivery cannot be feasible" };

  let byDeadline: Extract<CapacityProof, { verified: true }>["byDeadline"] = null;
  if (deadline) {
    const day = dayIndex(startDate, deadline);
    if (!Number.isInteger(day)) return { verified: false, reason: "invalid deadline" };
    const lastWork = day - e.shippingDays - 1;
    const cap = f.makers[0].dailyCapacity.value;
    const capacity = lastWork < 0 ? 0 : cap.slice(0, Math.min(lastWork, HORIZON - 1) + 1).reduce((a, b) => a + b, 0);
    let max: number;
    if (day < 0) max = 0;
    else {
      const ev = verified(f, { quantity, deliveryDay: day, budgetUsdCents: null }, now);
      if (typeof ev === "string") return { verified: false, reason: ev };
      max = ev.kind === "feasible" ? quantity : ev.kind === "infeasible_capacity" ? ev.maxQuantity : -1;
      if (max < 0) return { verified: false, reason: "unexpected result" };
    }
    byDeadline = { date: deadline.slice(0, 10), fits: max >= quantity, max, lastWorkDay: dayDate(startDate, Math.max(-1, lastWork)), capacity, booked: e.backlogPieces };
  }
  return { verified: true, quantity, byDeadline, earliest };
}
