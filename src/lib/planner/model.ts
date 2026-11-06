import { createHash } from "node:crypto";
import { canonical } from "@/lib/passport/signing";

/**
 * Collective order planner, model M1 — shared TYPES and the facts hash only.
 * The contract is docs/planner-model.md. The solver (solve.ts) and the independent
 * checker (check.ts) must not import each other.
 */

export const PLANNER_MODEL = "m1" as const;

export type Source = "maker_confirmed" | "coordinator_entered" | "buyer_stated" | "system";
export type Provenance = { source: Source; by?: string; at: string /* ISO timestamp */ };
export type Sourced<T> = { value: T; prov: Provenance };

export type Commitment = { ref: string; pieces: number; dueDay: number | null };

export type MakerFacts = {
  id: string;
  name: string;
  /** She confirmed she can make THIS specification. */
  capable: Sourced<boolean>;
  /** Pieces of this specification per day, index 0 … H−1. */
  dailyCapacity: Sourced<number[]>;
  /** First day materials for this order are in hand; null = not known yet. */
  materialsReadyDay: Sourced<number> | null;
  /** Her other promises (use her capacity, not shared finishing). */
  commitments: Sourced<Commitment[]>;
  askInrPerPiece: Sourced<number>;
  /** Private. Never leaves the internal view. */
  floorInrPerPiece: Sourced<number>;
  /** Most pieces she is willing to take on this order. */
  maxPieces: Sourced<number> | null;
  /** Per-maker activation cost. Unsupported in M1 when > 0. */
  fixedCostInr: number;
};

export type Reservation = {
  planId: string;
  production: { makerId: string; day: number; pieces: number }[];
  finishing: { day: number; pieces: number }[];
};

export type CollectiveFacts = {
  /** ISO date (YYYY-MM-DD) of day 0. */
  startDate: string;
  horizonDays: number;
  finishingPerDay: Sourced<number[]>;
  lagDays: number;
  packDays: number;
  transitDays: Sourced<number>;
  costs: {
    finishingInrPerPiece: number;
    packagingInrPerPiece: number;
    collectionInrPerPiece: number;
    /** Disclosed collective charge. */
    chargeInrPerPiece: number;
    shippingInrPerOrder: number;
  };
  fee: { percent: number; fixedUsdCents: number };
  inrPerUsd: Sourced<number>;
  reservations: Reservation[];
  /** maker_confirmed availability/commitments older than this are stale. */
  staleAfterDays: number;
  makers: MakerFacts[];
};

export type OrderRequest = { quantity: number; deliveryDay: number; budgetUsdCents: number | null };

export type ProductionEntry = { makerId: string; day: number; pieces: number };
export type FinishingEntry = { day: number; pieces: number };

export type Money = {
  perMaker: { makerId: string; pieces: number; payInr: number }[];
  makersInr: number;
  finishingInr: number;
  packagingInr: number;
  collectionInr: number;
  chargeInr: number;
  shippingInr: number;
  totalCostInr: number;
  priceUsdCents: number;
  estFeeUsdCents: number;
};

export type Plan = {
  model: typeof PLANNER_MODEL;
  factsHash: string;
  quantity: number;
  deliveryDay: number;
  lastFinishDay: number;
  production: ProductionEntry[];
  finishing: FinishingEntry[];
  money: Money;
};

/** A capacity cut: cut-off day τ and, per maker, a day u or "cap". See docs §3. */
export type CutCert = {
  lastFinishDay: number;
  tau: number;
  makers: { makerId: string; u: number | "cap" }[];
  /** The solver's value of the bound; the checker recomputes it from raw facts. */
  bound: number;
};

/** Per price level: the makers asking ≤ that level, and a cut bounding their total (null when the bound is Q itself). */
export type OptimalityCert = { levels: { askInr: number; makerIds: string[]; cut: CutCert | null }[] };

export type IssueCode = "missing" | "stale" | "inconsistent" | "unsupported" | "excluded" | "estimate" | "beyond_horizon" | "error";
export type Issue = { code: IssueCode; makerId?: string; fact: string; en: string; hi: string };

export type Alternatives = {
  earliestDelivery?:
    | { kind: "found"; plan: Plan; dayBeforeCut: CutCert | null; optimality: OptimalityCert; certified: boolean }
    | { kind: "not_within_horizon"; horizonDays: number; cut: CutCert };
  largestByDate?: { quantity: number; plan: Plan | null; cut: CutCert; optimality: OptimalityCert | null; certified: boolean };
  largestWithinBudget?: { quantity: number; plan: Plan; optimality: OptimalityCert; certified: boolean } | { quantity: 0 };
};

export type Evaluation =
  | { kind: "feasible"; plan: Plan; optimality: OptimalityCert; certified: boolean; notes: Issue[] }
  | { kind: "infeasible_capacity"; requested: number; maxQuantity: number; cut: CutCert; alternatives: Alternatives; notes: Issue[] }
  | { kind: "infeasible_budget"; plan: Plan; optimality: OptimalityCert; certified: boolean; budgetUsdCents: number; alternatives: Alternatives; notes: Issue[] }
  | { kind: "unresolved"; issues: Issue[]; /** what the complete facts alone support, if anything */ partial?: { maxQuantity: number } };

export function factsHash(facts: CollectiveFacts, request: OrderRequest): string {
  return createHash("sha256").update(canonical({ model: PLANNER_MODEL, facts, request })).digest("hex");
}

const DAY = 86_400_000;
export function dayIndex(startDate: string, iso: string): number {
  return Math.round((Date.parse(iso.slice(0, 10) + "T00:00:00Z") - Date.parse(startDate + "T00:00:00Z")) / DAY);
}
export function dayDate(startDate: string, day: number): string {
  return new Date(Date.parse(startDate + "T00:00:00Z") + day * DAY).toISOString().slice(0, 10);
}

/** Even daily split of a weekly rate: cumulative capacity through day t is floor((t+1)·rate/7). */
export function weeklyToDaily(piecesPerWeek: number, horizonDays: number, unavailable: number[] = []): number[] {
  const off = new Set(unavailable);
  return Array.from({ length: horizonDays }, (_, t) =>
    off.has(t) ? 0 : Math.floor(((t + 1) * piecesPerWeek) / 7) - Math.floor((t * piecesPerWeek) / 7),
  );
}
