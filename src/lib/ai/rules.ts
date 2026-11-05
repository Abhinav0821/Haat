import { generateText, Output } from "ai";
import { z } from "zod";
import { model } from "@/lib/ai/model";
import { EconomicsSchema, type Economics } from "@/lib/economics";

/**
 * The maker states her rules by voice ("materials ₹350, packing ₹50, shipping
 * to the US costs me ₹1,200, I need at least ₹1,500 per piece, four a week").
 * The model only EXTRACTS what she said; merging, currency conversion and the
 * read-back are code. Nothing is saved until she approves.
 */

const Heard = z.object({
  transcript: z.string().describe("What she said, verbatim, without timestamps."),
  materialsInr: z.number().nullable().describe("Per-piece materials cost in rupees, if stated."),
  packagingInr: z.number().nullable(),
  otherInr: z.number().nullable().describe("Other per-piece costs in rupees (e.g. dyeing, transport to post office)."),
  shippingCostInr: z.number().nullable().describe("What SHE pays the courier per international parcel, in rupees."),
  shippingCharge: z
    .object({ amount: z.number(), currency: z.enum(["INR", "USD"]) })
    .nullable()
    .describe("What the BUYER should be charged for shipping, if stated."),
  minimumInr: z.number().nullable().describe("The least she wants left for her work per piece, in rupees."),
  piecesPerWeek: z.number().int().nullable(),
  backlogPieces: z.number().int().nullable().describe("Pieces she has already promised to other customers, if stated."),
  shippingDays: z.number().int().nullable().describe("Typical courier days to the buyer."),
  askBeforeChanges: z.boolean().nullable().describe("True if she wants to be asked before materials/colours are changed."),
});

export async function hearRules(input: { text?: string; audio?: { data: Uint8Array; mediaType: string } }) {
  const { output } = await generateText({
    model: model(),
    system:
      "An Indian artisan is describing her costs and rules, usually in Hindi. Extract ONLY numbers and rules she actually states; use null for anything not mentioned. Convert Hindi number words to digits. Do not guess.",
    messages: [
      {
        role: "user",
        content: [
          ...(input.audio ? [{ type: "file" as const, data: input.audio.data, mediaType: input.audio.mediaType }] : []),
          ...(input.text ? [{ type: "text" as const, text: input.text }] : []),
        ],
      },
    ],
    output: Output.object({ schema: Heard, name: "rules" }),
  });
  if (!output) throw new Error("could not understand the rules");
  return output;
}

/** Merge what she said into her current rules (deterministic). */
export function mergeRules(current: Economics | null, heard: z.infer<typeof Heard>, inrPerUsd: number): Economics {
  const base = EconomicsSchema.parse(current ?? { materialsInr: null, packagingInr: null, shippingCostInr: null, minimumInr: null, piecesPerWeek: null, backlogPieces: 0 });
  const charge = heard.shippingCharge
    ? Math.round(heard.shippingCharge.currency === "USD" ? heard.shippingCharge.amount * 100 : (heard.shippingCharge.amount / inrPerUsd) * 100)
    : null;
  return EconomicsSchema.parse({
    ...base,
    ...(heard.materialsInr !== null ? { materialsInr: heard.materialsInr } : {}),
    ...(heard.packagingInr !== null ? { packagingInr: heard.packagingInr } : {}),
    ...(heard.otherInr !== null ? { otherInr: heard.otherInr } : {}),
    ...(heard.shippingCostInr !== null ? { shippingCostInr: heard.shippingCostInr } : {}),
    ...(charge !== null ? { shippingChargeUsdCents: charge } : {}),
    ...(heard.minimumInr !== null ? { minimumInr: heard.minimumInr } : {}),
    ...(heard.piecesPerWeek !== null ? { piecesPerWeek: heard.piecesPerWeek } : {}),
    ...(heard.backlogPieces !== null ? { backlogPieces: heard.backlogPieces } : {}),
    ...(heard.shippingDays !== null ? { shippingDays: heard.shippingDays } : {}),
    ...(heard.askBeforeChanges !== null ? { askBeforeChanges: heard.askBeforeChanges } : {}),
  });
}

const inr = (n: number) => `${Math.round(n).toLocaleString("en-IN")} रुपये`;

/** Fixed-template read-back in Hindi, including what's still missing. */
export function rulesReadbackHi(e: Economics): { text: string; missing: string[] } {
  const parts: string[] = [];
  const missing: string[] = [];
  if (e.materialsInr !== null) parts.push(`सामान का खर्च हर पीस ${inr(e.materialsInr)}`);
  else missing.push("सामान का खर्च");
  if (e.packagingInr !== null) parts.push(`पैकिंग ${inr(e.packagingInr)}`);
  else missing.push("पैकिंग का खर्च");
  if (e.otherInr) parts.push(`दूसरे खर्च ${inr(e.otherInr)}`);
  if (e.shippingCostInr !== null) parts.push(`विदेश भेजने का आपका खर्च ${inr(e.shippingCostInr)}`);
  else missing.push("भेजने का खर्च");
  parts.push(e.shippingChargeUsdCents ? `ग्राहक से शिपिंग ${(e.shippingChargeUsdCents / 100).toFixed(2)} डॉलर लेंगे` : "ग्राहक से शिपिंग नहीं लेंगे");
  if (e.minimumInr !== null) parts.push(`हर पीस पर आपकी मेहनत के लिए कम से कम ${inr(e.minimumInr)} बचने चाहिए`);
  else missing.push("आपकी कम से कम कमाई");
  if (e.piecesPerWeek !== null) parts.push(`हफ़्ते में ${e.piecesPerWeek} पीस तक बना सकती हैं`);
  else missing.push("हफ़्ते में कितने पीस");
  if (e.backlogPieces) parts.push(`अभी ${e.backlogPieces} पीस का काम बाकी है`);
  parts.push(`पार्सल पहुँचने में लगभग ${e.shippingDays} दिन`);
  parts.push(e.askBeforeChanges ? "रंग या सामान बदलने से पहले आपसे पूछा जाएगा" : "छोटे बदलाव बिना पूछे मान लिए जाएँगे");
  const text = `मैंने यह समझा: ${parts.join("; ")}।${missing.length ? ` अभी बताना बाकी है: ${missing.join(", ")}।` : ""} क्या यह सही है?`;
  return { text, missing };
}
