/**
 * Fair-price coach — pure, deterministic analysis of comparable products.
 * The AI only helps find comparables; every number here is computed in code,
 * and the seller always decides the final price.
 */

export type Comparable = { title: string; priceCents: number; domain: string; url: string; image: string | null };

export type FairPrice = {
  count: number;
  lowCents: number; // 25th percentile
  medianCents: number;
  highCents: number; // 75th percentile
  verdict: "under" | "fair" | "over";
  suggestedCents: number | null; // only when the seller is clearly under-priced
  examples: Comparable[];
  hi: string;
  en: string;
};

const usd = (c: number) => `$${Math.round(c / 100)}`;

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}

/** Keep only items of the same kind (title contains a type word) and drop price outliers. */
export function selectComparables(items: Comparable[], typeKeywords: string[]): Comparable[] {
  const words = typeKeywords.map((w) => w.toLowerCase().trim()).filter((w) => w.length > 2);
  // Channel3 can return the same product several times (variants, colourways): count it once.
  const seen = new Set<string>();
  const unique = items.filter((i) => {
    const key = `${i.title.toLowerCase().trim()}|${i.domain}|${i.priceCents}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const sameKind = unique.filter(
    (i) => i.priceCents > 0 && words.some((w) => new RegExp(`\\b${w.replace(/[^a-z0-9 -]/g, "")}s?\\b`, "i").test(i.title)),
  );
  if (sameKind.length < 4) return sameKind;
  const prices = sameKind.map((i) => i.priceCents).sort((a, b) => a - b);
  const q1 = quantile(prices, 0.25);
  const q3 = quantile(prices, 0.75);
  const fence = (q3 - q1) * 1.5;
  return sameKind.filter((i) => i.priceCents >= q1 - fence && i.priceCents <= q3 + fence);
}

export function analyzeFairPrice(comps: Comparable[], currentCents: number | null): FairPrice | null {
  if (comps.length < 3) return null; // not enough evidence to advise
  const prices = comps.map((c) => c.priceCents).sort((a, b) => a - b);
  const lowCents = quantile(prices, 0.25);
  const medianCents = quantile(prices, 0.5);
  const highCents = quantile(prices, 0.75);

  let verdict: FairPrice["verdict"] = "fair";
  if (currentCents !== null && currentCents < lowCents) verdict = "under";
  else if (currentCents !== null && currentCents > highCents) verdict = "over";

  // Conservative suggestion: the low end of the typical range, rounded to whole dollars.
  const suggestedCents = verdict === "under" ? Math.max(100, Math.round(lowCents / 100) * 100) : null;

  const examples = [...comps].sort((a, b) => Math.abs(a.priceCents - medianCents) - Math.abs(b.priceCents - medianCents)).slice(0, 3);
  const range = `${usd(lowCents)}–${usd(highCents)}`;
  const mine = currentCents !== null ? usd(currentCents) : null;

  const hi =
    verdict === "under"
      ? `मिलती-जुलती ${comps.length} चीज़ें ${range} में बिक रही हैं। आपकी कीमत ${mine} बहुत कम है — आप ${usd(suggestedCents!)} रख सकती हैं।`
      : verdict === "over"
        ? `मिलती-जुलती ${comps.length} चीज़ें ${range} में बिक रही हैं। आपकी कीमत ${mine} इनसे ज़्यादा है — अगर ख़ास काम है तो ठीक है।`
        : `मिलती-जुलती ${comps.length} चीज़ें ${range} में बिक रही हैं। आपकी कीमत${mine ? ` ${mine}` : ""} ठीक है।`;
  const en =
    verdict === "under"
      ? `${comps.length} similar items sell for ${range}. Your ${mine} is well below that — consider ${usd(suggestedCents!)}.`
      : verdict === "over"
        ? `${comps.length} similar items sell for ${range}. Your ${mine} is above that — fine if the work justifies it.`
        : `${comps.length} similar items sell for ${range}. Your price${mine ? ` (${mine})` : ""} is in line.`;

  return { count: comps.length, lowCents, medianCents, highCents, verdict, suggestedCents, examples, hi, en };
}
