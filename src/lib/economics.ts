import { z } from "zod";

/**
 * The maker's economics — one deterministic calculation used everywhere
 * (listing preview, quotes, agreements). No AI in here.
 *
 *   buyer pays (USD)       = goods subtotal + shipping CHARGED to the buyer
 *   after PayPal (USD)     = buyer pays − estimated PayPal fee
 *   in rupees (estimate)   = after PayPal × estimated exchange rate
 *   left for her work (₹)  = in rupees − shipping COST she pays − materials − packaging − other costs
 *
 * "Left for her work" is what pays for her labour and any profit. It is a LOSS
 * only when negative; otherwise it may merely be "below her minimum".
 * Fee and exchange rate are estimates; PayPal's actual fee arrives at capture.
 */

export const EconomicsSchema = z.object({
  /** Per piece, in rupees. */
  materialsInr: z.number().min(0).nullable(),
  packagingInr: z.number().min(0).nullable(),
  otherInr: z.number().min(0).default(0),
  /** Per order: what she actually pays the courier for an international parcel. */
  shippingCostInr: z.number().min(0).nullable(),
  /** Per order: what the buyer is charged for shipping (USD cents). */
  shippingChargeUsdCents: z.number().int().min(0).default(0),
  /** Per piece: the least she wants left for her work. */
  minimumInr: z.number().min(0).nullable(),
  /** Capacity: pieces she can finish per week, and days the courier usually takes. */
  piecesPerWeek: z.number().int().min(1).nullable(),
  shippingDays: z.number().int().min(1).default(10),
  /** Ask her before agreeing to a different material or colour. */
  askBeforeChanges: z.boolean().default(true),
  /** PayPal fee estimate (labelled as an estimate everywhere it's shown). */
  feePercent: z.number().min(0).max(20).default(5.4),
  feeFixedUsdCents: z.number().int().min(0).default(30),
});
export type Economics = z.infer<typeof EconomicsSchema>;

export function readEconomics(policy: unknown): Economics | null {
  const raw = (policy as { economics?: unknown } | null)?.economics;
  if (!raw) return null;
  const parsed = EconomicsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export type Earnings = {
  pieces: number;
  buyerPaysUsdCents: number;
  goodsUsdCents: number;
  shippingChargedUsdCents: number;
  estFeeUsdCents: number;
  estInrAfterPayPal: number;
  costs: { materials: number; packaging: number; other: number; shipping: number; total: number };
  leftForWorkInr: number;
  perPieceInr: number;
  verdict: "loss" | "below_minimum" | "meets_minimum" | "no_minimum";
  missing: ("materials" | "packaging" | "shipping cost")[];
  assumptions: string[];
};

export function computeEarnings(
  e: Economics,
  { unitPriceUsdCents, pieces, inrPerUsd }: { unitPriceUsdCents: number; pieces: number; inrPerUsd: number },
): Earnings | { missing: ("materials" | "packaging" | "shipping cost")[] } {
  const missing: ("materials" | "packaging" | "shipping cost")[] = [];
  if (e.materialsInr === null) missing.push("materials");
  if (e.packagingInr === null) missing.push("packaging");
  if (e.shippingCostInr === null) missing.push("shipping cost");
  if (missing.length) return { missing }; // ask, don't guess

  const goods = unitPriceUsdCents * pieces;
  const buyerPays = goods + e.shippingChargeUsdCents;
  const fee = Math.round((buyerPays * e.feePercent) / 100) + e.feeFixedUsdCents;
  const inrAfterPayPal = Math.round(((buyerPays - fee) / 100) * inrPerUsd);
  const costs = {
    materials: Math.round(e.materialsInr! * pieces),
    packaging: Math.round(e.packagingInr! * pieces),
    other: Math.round(e.otherInr * pieces),
    shipping: Math.round(e.shippingCostInr!),
    total: 0,
  };
  costs.total = costs.materials + costs.packaging + costs.other + costs.shipping;
  const left = inrAfterPayPal - costs.total;
  const perPiece = Math.round(left / pieces);
  const verdict = left < 0 ? "loss" : e.minimumInr === null ? "no_minimum" : perPiece < e.minimumInr ? "below_minimum" : "meets_minimum";
  return {
    pieces,
    buyerPaysUsdCents: buyerPays,
    goodsUsdCents: goods,
    shippingChargedUsdCents: e.shippingChargeUsdCents,
    estFeeUsdCents: fee,
    estInrAfterPayPal: inrAfterPayPal,
    costs,
    leftForWorkInr: left,
    perPieceInr: perPiece,
    verdict,
    missing: [],
    assumptions: [
      `PayPal fee estimated at ${e.feePercent}% + $${(e.feeFixedUsdCents / 100).toFixed(2)} (actual fee is known after payment)`,
      `₹${inrPerUsd} per $1 estimated (PayPal's conversion rate may differ)`,
    ],
  };
}

const inr = (n: number) => `₹${Math.abs(Math.round(n)).toLocaleString("en-IN")}`;

/** One spoken sentence, from fixed templates. */
export function earningsSentenceHi(x: Earnings, minimumInr: number | null): string {
  const each = x.pieces > 1 ? "हर पीस पर" : "इस पीस पर";
  if (x.verdict === "loss") return `इस दाम पर आपको नुकसान होगा — लगभग ${inr(x.leftForWorkInr)} कम पड़ेंगे।`;
  const base = `इस दाम पर, सारे खर्च और PayPal फ़ीस के बाद, ${each} आपकी मेहनत के लिए लगभग ${inr(x.perPieceInr)} बचेंगे।`;
  if (x.verdict === "below_minimum" && minimumInr !== null) return `${base} यह आपके तय किए ${inr(minimumInr)} से कम है।`;
  return base;
}

export function earningsSentenceEn(x: Earnings, minimumInr: number | null): string {
  if (x.verdict === "loss") return `At this price you would make a loss of about ${inr(x.leftForWorkInr)}.`;
  const base = `After all costs and PayPal fees, about ${inr(x.perPieceInr)} per piece is left for your work.`;
  if (x.verdict === "below_minimum" && minimumInr !== null) return `${base} That is below your minimum of ${inr(minimumInr)}.`;
  return base;
}
