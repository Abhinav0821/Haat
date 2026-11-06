import { createHash } from "node:crypto";
import { canonical } from "@/lib/passport/signing";
import { dayDate, type Plan } from "@/lib/planner/model";

/**
 * The words people agree to. Each maker's part and the buyer's terms are frozen and
 * hashed; the overall plan's terms reference every part by id AND hash, so a change
 * to anyone's part is a new plan version. Both languages are inside the hashed terms,
 * so what she hears and what the buyer reads come from the same approved content.
 */

export const hashOf = (x: unknown) => createHash("sha256").update(canonical(x)).digest("hex");

const HANDMADE_EN = "Each piece is made by hand by a different maker in the collective: small differences between pieces are part of handmade work.";
const REFUND_EN = "Made to order, so no returns for change of mind. Pieces that arrive damaged or not as agreed are refunded by the collective.";

export type Product = { en: string; hi: string };

export type PartTerms = {
  v: 1;
  collective: string;
  orderRef: string;
  product: Product;
  details: string | null;
  pieces: number;
  /** Day-by-day: how many pieces she makes on each date. */
  schedule: { date: string; pieces: number }[];
  makeBy: string;
  /** Shared dates her part depends on. */
  finishingEnds: string;
  dispatchBy: string;
  askInrPerPiece: number;
  payInr: number;
  payment: { en: string; hi: string };
};

export type BuyerTerms = {
  v: 1;
  collective: string;
  product: Product;
  details: string | null;
  quantity: number;
  requested: { quantity: number; deadline: string; budgetUsdCents: number | null };
  dispatchBy: string;
  deliveryEstimate: string;
  totalUsdCents: number;
  makers: number;
  handmadeVariation: string;
  refundTerms: string;
};

export type PlanTerms = { buyer: BuyerTerms; parts: { memberId: string; partId: string; termsHash: string }[] };

export function partTerms(
  plan: Plan,
  startDate: string,
  memberId: string,
  ctx: { collective: string; orderRef: string; product: Product; details: string | null; transitDays: number },
): PartTerms | null {
  const mine = plan.production.filter((p) => p.makerId === memberId).sort((a, b) => a.day - b.day);
  const pay = plan.money.perMaker.find((p) => p.makerId === memberId);
  if (!mine.length || !pay) return null;
  const pieces = mine.reduce((s, p) => s + p.pieces, 0);
  const byDate = new Map<string, number>();
  for (const p of mine) byDate.set(dayDate(startDate, p.day), (byDate.get(dayDate(startDate, p.day)) ?? 0) + p.pieces);
  const schedule = [...byDate].map(([date, n]) => ({ date, pieces: n }));
  const payInr = pay.payInr;
  return {
    v: 1,
    collective: ctx.collective,
    orderRef: ctx.orderRef,
    product: ctx.product,
    details: ctx.details,
    pieces,
    schedule,
    makeBy: schedule[schedule.length - 1].date,
    finishingEnds: dayDate(startDate, plan.lastFinishDay),
    dispatchBy: dayDate(startDate, plan.deliveryDay - ctx.transitDays),
    askInrPerPiece: Math.round((payInr / pieces) * 100) / 100,
    payInr,
    payment: {
      en: `The collective sells this order. When the buyer's payment is received, the collective owes you ₹${payInr.toLocaleString("en-IN")}. Each payment to you is recorded with its UPI or bank reference, and you confirm it.`,
      hi: `यह ऑर्डर संगठन बेचता है। ख़रीदार का पैसा आने पर संगठन पर आपके ₹${payInr.toLocaleString("en-IN")} बकाया होंगे। आपको हर भुगतान UPI या बैंक के नंबर के साथ दर्ज होगा, और आप उसकी पुष्टि करेंगी।`,
    },
  };
}

export function buyerTerms(
  plan: Plan,
  startDate: string,
  ctx: { collective: string; product: Product; details: string | null; transitDays: number; requested: BuyerTerms["requested"] },
): BuyerTerms {
  return {
    v: 1,
    collective: ctx.collective,
    product: ctx.product,
    details: ctx.details,
    quantity: plan.quantity,
    requested: ctx.requested,
    dispatchBy: dayDate(startDate, plan.deliveryDay - ctx.transitDays),
    deliveryEstimate: dayDate(startDate, plan.deliveryDay),
    totalUsdCents: plan.money.priceUsdCents,
    makers: new Set(plan.production.map((p) => p.makerId)).size,
    handmadeVariation: HANDMADE_EN,
    refundTerms: REFUND_EN,
  };
}

const hiDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("hi-IN", { day: "numeric", month: "long", timeZone: "UTC" });
const enDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Consecutive days with the same number of pieces, merged (easier to hear). */
export function runs(schedule: { date: string; pieces: number }[]) {
  const next = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const out: { from: string; to: string; pieces: number }[] = [];
  for (const s of schedule) {
    const last = out[out.length - 1];
    if (last && last.pieces === s.pieces && next(last.to) === s.date) last.to = s.date;
    else out.push({ from: s.date, to: s.date, pieces: s.pieces });
  }
  return out;
}

/** Her part, read aloud: a fixed template that includes every clause of the terms. */
export function partReadbackHi(t: PartTerms): string {
  const days = runs(t.schedule)
    .map((r) => (r.from === r.to ? `${hiDay(r.from)} को ${r.pieces}` : `${hiDay(r.from)} से ${hiDay(r.to)} तक रोज़ ${r.pieces}`))
    .join(", ");
  return [
    `${t.collective} का ऑर्डर, ${t.product.hi}${t.details ? ` (${t.details})` : ""}।`,
    `आपका हिस्सा ${t.pieces} पीस: ${days}।`,
    `हर पीस ₹${t.askInrPerPiece.toLocaleString("en-IN")}, कुल ₹${t.payInr.toLocaleString("en-IN")}।`,
    `फ़िनिशिंग ${hiDay(t.finishingEnds)} तक पूरी होनी है और ऑर्डर ${hiDay(t.dispatchBy)} को भेजा जाएगा, इसलिए आपके पीस तय दिनों पर चाहिए।`,
    t.payment.hi,
  ].join(" ");
}

export function partLinesEn(t: PartTerms): [string, string][] {
  return [
    ["Order", `${t.product.en}${t.details ? ` (${t.details})` : ""}`],
    ["Your part", `${t.pieces} pieces`],
    ["When", runs(t.schedule).map((r) => (r.from === r.to ? `${enDay(r.from)}: ${r.pieces}` : `${enDay(r.from)}–${enDay(r.to)}: ${r.pieces} a day`)).join(" · ")],
    ["Your pay", `₹${t.askInrPerPiece.toLocaleString("en-IN")} each · ₹${t.payInr.toLocaleString("en-IN")} in all`],
    ["Depends on", `finishing ends ${enDay(t.finishingEnds)}; dispatch ${enDay(t.dispatchBy)}`],
    ["Payment", t.payment.en],
  ];
}

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const longDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** The buyer's reading of the terms. Every clause appears; nothing about any maker's pay or limits. */
export function buyerLinesEn(t: BuyerTerms): [string, string][] {
  const changed: string[] = [];
  if (t.quantity !== t.requested.quantity) changed.push(`${t.quantity} pieces instead of the ${t.requested.quantity} you asked for`);
  if (t.deliveryEstimate > t.requested.deadline) changed.push(`delivery after your date of ${longDay(t.requested.deadline)}`);
  if (t.requested.budgetUsdCents !== null && t.totalUsdCents > t.requested.budgetUsdCents) changed.push(`above your budget of ${usd(t.requested.budgetUsdCents)}`);
  return [
    ["Item", `${t.quantity} × ${t.product.en}${t.details ? ` (${t.details})` : ""}`],
    ...(changed.length ? ([["Differs from your request", changed.join("; ")]] as [string, string][]) : []),
    ["Total", `${usd(t.totalUsdCents)} including shipping`],
    ["Made by", `${t.makers} maker${t.makers === 1 ? "" : "s"} of ${t.collective}`],
    ["Dispatched by", longDay(t.dispatchBy)],
    ["Estimated delivery", `${longDay(t.deliveryEstimate)} (estimate — courier times vary)`],
    ["Handmade variation", t.handmadeVariation],
    ["Refunds", t.refundTerms],
  ];
}
