/** Pure data shared by server and browser code (no database imports). */

/**
 * The demo runs a single seller's shop. Multi-seller onboarding is out of scope
 * for the hackathon, but every table is keyed by store_id so it's a small step.
 */
export const DEMO_STORE = {
  slug: "meera-block-prints",
  name: "Meera Block Prints",
  ownerName: "Meera",
  country: "IN",
  currency: "USD",
  policy: { refundWindowDays: 30, autoRefundMaxCents: 0, photoEvidenceAboveCents: 2000 },
} as const;

/** Presentation details for the demo maker (would live on the store row in a multi-seller build). */
export const MAKER_PROFILES: Record<
  string,
  { place: string; craft: string; taglineHi: string; taglineEn: string; language: string; ownerNameHi: string }
> = {
  [DEMO_STORE.slug]: {
    language: "Hindi",
    ownerNameHi: "मीरा",
    place: "Bagru, Jaipur · Rajasthan",
    craft: "Hand block printing with natural dyes",
    taglineHi: "हाथ से बना, दिल से बेचा",
    taglineEn: "Made by hand, sold from the heart",
  },
};

export function sellerLanguage(slug: string): string {
  return MAKER_PROFILES[slug]?.language ?? "Hindi";
}
