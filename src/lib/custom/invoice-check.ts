import { computeEarnings, earningsSentenceEn, earningsSentenceHi, type Economics } from "@/lib/economics";
import { completionDate, isoDate } from "./quote";

/**
 * An invoice she dictates (for a buyer who reached her outside Haat) is checked
 * against the SAME rules as a custom order on Haat. She still decides — the price
 * is hers — but a loss or a price below her own minimum needs an explicit
 * "create anyway", enforced on the server.
 *
 * The invoice amount is everything the buyer pays, so no separate shipping
 * charge is added; her courier cost is still deducted once.
 */
export type InvoiceCheck = {
  verdict: "loss" | "below_minimum" | "meets_minimum" | "no_minimum" | "unknown";
  needsOverride: boolean;
  hi: string;
  en: string;
  perPieceInr: number | null;
  readyBy: string | null;
};

const hiDay = (iso: string) => new Date(iso).toLocaleDateString("hi-IN", { day: "numeric", month: "long", timeZone: "UTC" });

export function invoiceCheck(
  e: Economics | null,
  x: { amountCents: number; pieces: number; inrPerUsd: number; backlogPieces: number; now: Date },
): InvoiceCheck {
  if (!e) {
    return { verdict: "unknown", needsOverride: false, hi: "आपके नियम सेव नहीं हैं, इसलिए कमाई जाँची नहीं जा सकी।", en: "Your rules aren't saved, so earnings weren't checked.", perPieceInr: null, readyBy: null };
  }
  const pieces = Math.max(1, Math.round(x.pieces));
  const readyBy = e.piecesPerWeek ? isoDate(completionDate(x.now, x.backlogPieces, pieces, e.piecesPerWeek)) : null;
  const capacityHi = readyBy ? ` अभी के काम के साथ ${pieces} पीस ${hiDay(readyBy)} तक बन पाएँगे।` : "";
  const capacityEn = readyBy ? ` With work already booked, ${pieces} piece${pieces > 1 ? "s" : ""} can be ready by ${readyBy}.` : "";

  const r = computeEarnings({ ...e, shippingChargeUsdCents: 0 }, { unitPriceUsdCents: x.amountCents / pieces, pieces, inrPerUsd: x.inrPerUsd });
  if (!("verdict" in r)) {
    return {
      verdict: "unknown",
      needsOverride: false,
      hi: `कमाई जाँचने के लिए ये खर्च बताना बाकी है: ${r.missing.join(", ")}।${capacityHi}`,
      en: `To check earnings, still missing: ${r.missing.join(", ")}.${capacityEn}`,
      perPieceInr: null,
      readyBy,
    };
  }
  return {
    verdict: r.verdict,
    needsOverride: r.verdict === "loss" || r.verdict === "below_minimum",
    hi: earningsSentenceHi(r, e.minimumInr) + capacityHi,
    en: earningsSentenceEn(r, e.minimumInr) + capacityEn,
    perPieceInr: r.perPieceInr,
    readyBy,
  };
}
