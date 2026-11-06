import { computeEarnings, type Earnings, type Economics } from "@/lib/economics";

/**
 * Custom-order rules — pure and deterministic. The AI turns speech into
 * options; THIS code decides whether each option respects the maker's
 * earnings minimum, capacity and conditions.
 */

const DAY = 86_400_000;
const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
export const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** When production can finish: work already booked + this order, at her weekly rate. */
export function completionDate(now: Date, backlogPieces: number, quantity: number, piecesPerWeek: number): Date {
  // Integer arithmetic: (n / rate) × 7 in floating point can round up a whole day (29 pieces at 7/week).
  const days = Math.ceil(((backlogPieces + quantity) * 7) / piecesPerWeek);
  return new Date(startOfDay(now).getTime() + days * DAY);
}

/** Delivery is estimated separately from completion: completion + courier days. */
export function deliveryEstimate(completion: Date, shippingDays: number): Date {
  return new Date(completion.getTime() + shippingDays * DAY);
}

/** Most pieces she can promise for delivery by `deadline`, given work already booked. */
export function maxQuantityByDeadline(now: Date, deadline: Date, backlogPieces: number, piecesPerWeek: number, shippingDays: number): number {
  const workDays = Math.floor((startOfDay(deadline).getTime() - shippingDays * DAY - startOfDay(now).getTime()) / DAY);
  if (workDays <= 0) return 0;
  return Math.max(0, Math.floor((workDays * piecesPerWeek) / 7) - backlogPieces);
}

/** Lowest unit price (USD cents) that leaves at least her minimum per piece. Verified with computeEarnings. */
export function minimumUnitPriceUsdCents(e: Economics, pieces: number, inrPerUsd: number): number | null {
  if (e.minimumInr === null) return null;
  const probe = computeEarnings(e, { unitPriceUsdCents: 100, pieces, inrPerUsd });
  if (!("verdict" in probe)) return null; // costs missing
  // Analytic estimate, then step up to absorb rounding.
  const costs = probe.costs.total + e.minimumInr * pieces;
  const needUsdCents = (costs / inrPerUsd) * 100;
  const grossCents = (needUsdCents + e.feeFixedUsdCents) / (1 - e.feePercent / 100);
  // Start a little BELOW the estimate and walk up, so the result is the true lowest price
  // under computeEarnings' rounding (never over-quote the buyer).
  let unit = Math.max(100, Math.floor((grossCents - e.shippingChargeUsdCents) / pieces) - 50);
  for (let i = 0; i < 1000; i++) {
    const x = computeEarnings(e, { unitPriceUsdCents: unit, pieces, inrPerUsd });
    if ("verdict" in x && x.perPieceInr >= e.minimumInr) return unit;
    unit += 1;
  }
  return null;
}

export type CustomSpec = {
  quantity: number;
  item: string;
  colors: string[];
  materials: string[];
  deadline: string | null; // ISO date the buyer needs delivery by
  budgetUsdCents: number | null; // total budget, if stated
};

export type Option = {
  quantity: number;
  unitPriceUsdCents: number;
  /** Completion date the maker stated, if any. */
  completionBy: string | null;
  colors: string[] | null; // proposed changes vs the request
  materials: string[] | null;
  note: string | null;
  /** Her condition in her own words (Hindi), for her read-back of the terms. */
  noteHi?: string | null;
};

export type Check = { code: string; ok: boolean; blocking: boolean; hi: string; en: string };

export type OptionVerdict = {
  option: Option;
  status: "valid" | "blocked";
  earnings: Earnings | null;
  completion: string;
  delivery: string;
  totalUsdCents: number;
  checks: Check[];
};

const inr = (n: number) => `₹${Math.round(Math.abs(n)).toLocaleString("en-IN")}`;
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

export function validateOption(o: Option, req: CustomSpec, e: Economics, ctx: { now: Date; inrPerUsd: number }): OptionVerdict {
  const checks: Check[] = [];
  const x = computeEarnings(e, { unitPriceUsdCents: o.unitPriceUsdCents, pieces: o.quantity, inrPerUsd: ctx.inrPerUsd });
  const earnings = "verdict" in x ? x : null;

  if (!earnings) {
    checks.push({ code: "costs_missing", ok: false, blocking: true, hi: "आपके खर्च पूरे नहीं बताए गए — पहले नियम पूरे करें।", en: "Costs are incomplete — finish your rules first." });
  } else if (earnings.verdict === "loss") {
    checks.push({ code: "loss", ok: false, blocking: true, hi: `इस दाम पर नुकसान होगा (लगभग ${inr(earnings.leftForWorkInr)})।`, en: `This would be a loss of about ${inr(earnings.leftForWorkInr)}.` });
  } else if (earnings.verdict === "below_minimum") {
    checks.push({ code: "below_minimum", ok: false, blocking: true, hi: `हर पीस पर ${inr(earnings.perPieceInr)} बचेंगे — आपके तय किए ${inr(e.minimumInr ?? 0)} से कम।`, en: `About ${inr(earnings.perPieceInr)} per piece is left — below your minimum of ${inr(e.minimumInr ?? 0)}.` });
  } else {
    checks.push({ code: "earnings_ok", ok: true, blocking: false, hi: `हर पीस पर लगभग ${inr(earnings.perPieceInr)} बचेंगे।`, en: `About ${inr(earnings.perPieceInr)} per piece is left for your work.` });
  }

  const ppw = e.piecesPerWeek;
  let completion = new Date(ctx.now);
  if (!ppw) {
    checks.push({ code: "capacity_unknown", ok: false, blocking: true, hi: "आप हफ़्ते में कितने पीस बना सकती हैं, यह बताना बाकी है।", en: "Weekly capacity isn't set yet." });
  } else {
    completion = completionDate(ctx.now, e.backlogPieces, o.quantity, ppw);
    if (o.completionBy && new Date(o.completionBy) < completion) {
      checks.push({
        code: "date_not_possible",
        ok: false,
        blocking: true,
        hi: `अभी के काम के साथ ${o.quantity} पीस ${isoDate(completion)} से पहले नहीं बन पाएँगे।`,
        en: `With your current work, ${o.quantity} piece${o.quantity === 1 ? "" : "s"} can't be finished before ${isoDate(completion)}.`,
      });
      completion = new Date(o.completionBy); // reported as stated, but blocked
    } else if (o.completionBy) {
      completion = new Date(o.completionBy);
    }
  }
  const delivery = deliveryEstimate(completion, e.shippingDays);

  if (req.deadline && delivery > new Date(req.deadline)) {
    checks.push({ code: "after_deadline", ok: false, blocking: false, hi: "पहुँचने का अनुमान ख़रीदार की तारीख़ के बाद है — ख़रीदार को मानना होगा।", en: `Estimated delivery (${isoDate(delivery)}) is after the buyer's date (${req.deadline}). The buyer must accept.` });
  }
  if (o.quantity < req.quantity) {
    checks.push({ code: "fewer_pieces", ok: true, blocking: false, hi: `${req.quantity} की जगह ${o.quantity} पीस।`, en: `${o.quantity} pieces instead of ${req.quantity}.` });
  }
  if ((o.colors && o.colors.join() !== req.colors.join()) || (o.materials && o.materials.join() !== req.materials.join())) {
    checks.push({ code: "changes_request", ok: true, blocking: false, hi: "रंग/सामान ख़रीदार के अनुरोध से अलग है — ख़रीदार को मानना होगा।", en: "Colour or material differs from the request — the buyer must accept." });
  }

  const totalUsdCents = o.unitPriceUsdCents * o.quantity + e.shippingChargeUsdCents;
  return {
    option: o,
    status: checks.some((c) => c.blocking) ? "blocked" : "valid",
    earnings,
    completion: isoDate(completion),
    delivery: isoDate(delivery),
    totalUsdCents,
    checks,
  };
}

export type CounterResult =
  | { acceptable: true; verdict: OptionVerdict }
  | { acceptable: false; reasonEn: string; reasonHi: string; alternatives: { en: string; quantity: number; unitPriceUsdCents: number }[] };

/** A buyer's counter-offer (total budget for N pieces) checked against her rules. */
export function evaluateCounter(
  counter: { quantity: number; totalBudgetUsdCents: number },
  req: CustomSpec,
  e: Economics,
  ctx: { now: Date; inrPerUsd: number },
): CounterResult {
  const ship = e.shippingChargeUsdCents;
  const unit = Math.floor((counter.totalBudgetUsdCents - ship) / counter.quantity);
  const v = validateOption({ quantity: counter.quantity, unitPriceUsdCents: Math.max(0, unit), completionBy: null, colors: null, materials: null, note: null }, req, e, ctx);
  if (v.status === "valid") return { acceptable: true, verdict: v };

  // Alternatives that respect her minimum: fewer pieces in the same budget, or the price for all pieces.
  const alternatives: { en: string; quantity: number; unitPriceUsdCents: number }[] = [];
  for (let q = counter.quantity - 1; q >= 1; q--) {
    const minUnit = minimumUnitPriceUsdCents(e, q, ctx.inrPerUsd);
    if (minUnit !== null && minUnit * q + ship <= counter.totalBudgetUsdCents) {
      alternatives.push({ quantity: q, unitPriceUsdCents: minUnit, en: `${q} pieces fit your budget (${usd(minUnit * q + ship)} incl. shipping).` });
      break;
    }
  }
  const minAll = minimumUnitPriceUsdCents(e, counter.quantity, ctx.inrPerUsd);
  if (minAll !== null) {
    alternatives.push({ quantity: counter.quantity, unitPriceUsdCents: minAll, en: `${counter.quantity} pieces would be ${usd(minAll * counter.quantity + ship)} incl. shipping.` });
  }
  const blocking = v.checks.find((c) => c.blocking)!;
  return {
    acceptable: false,
    reasonEn: blocking.code === "below_minimum" || blocking.code === "loss" ? "That price is below what the maker needs to earn for this work." : blocking.en,
    reasonHi: blocking.hi,
    alternatives,
  };
}
