import { randomInt } from "node:crypto";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { generateText, Output } from "ai";
import { z } from "zod";
import { db, schema } from "@/db";
import { model } from "@/lib/ai/model";
import { env } from "@/lib/env";
import { matchesCodeWord, pickCodeWord } from "@/lib/autopilot/code-words";
import { dHash, hamming, SAME_PHOTO_MAX_DISTANCE, sha256Hex } from "./image-hash";
import { signPayload } from "./signing";

/**
 * Maker Evidence (formerly "Handmade Passport") — evidence that the maker had
 * this piece in hand recently and that its photos are original. Three independent checks; code makes the decision:
 *
 *  1. Live possession: a fresh photo of the piece next to a handwritten,
 *     randomly issued code (read by AI vision, matched by code).
 *  2. Not mass-market: Channel3 visual search for the same product at
 *     ordinary retailers (AI compares the candidates).
 *  3. Original photos: perceptual hashes vs every other listing on Haat.
 *
 * We deliberately do NOT claim to detect AI-generated images — that isn't
 * reliable. Passing yields an Ed25519-signed passport anyone can verify.
 */

export const CODE_TTL_MS = 30 * 60_000;

export class PassportError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

type Image = { data: Uint8Array; mediaType: string };
type Flag = { code: string; hi: string; en: string };

async function loadProduct(productId: string, storeId: string) {
  const d = await db();
  const [p] = await d
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.id, productId), eq(schema.products.storeId, storeId), eq(schema.products.status, "live")));
  if (!p) throw new PassportError("product not found", 404);
  return p;
}

export async function startPassport(productId: string, storeId: string) {
  await loadProduct(productId, storeId);
  const d = await db();
  const [existing] = await d.select().from(schema.passports).where(eq(schema.passports.productId, productId));
  if (existing?.status === "verified") throw new PassportError("already verified", 409);

  const word = pickCodeWord();
  const code = `${word.hi} ${randomInt(1000, 10000)}`;
  const now = new Date();
  if (existing) {
    await d
      .update(schema.passports)
      .set({ code, codeIssuedAt: now, status: "awaiting_photo", proofMediaId: null, checks: null })
      .where(eq(schema.passports.id, existing.id));
  } else {
    await d.insert(schema.passports).values({ productId, storeId, code, codeIssuedAt: now, status: "awaiting_photo" });
  }
  return { code, wordEn: word.en, expiresAt: now.getTime() + CODE_TTL_MS };
}

// ── Check 1: live possession ────────────────────────────────────────────────

const ProofRead = z.object({
  handwrittenText: z.string().describe("Exactly what is handwritten on the paper (any script). Empty if no handwriting."),
  paperWithWritingVisible: z.boolean(),
  sameItemAsListing: z
    .enum(["yes", "no", "unsure", "no_listing_photos"])
    .describe("Is the piece next to the paper the same item as in the listing photos (pattern, colours, shape)?"),
  photoOfScreenOrPrint: z.boolean().describe("True if the photo shows a screen or a printed photo rather than a real object."),
  notes: z.string().max(240),
});

export async function readProofPhoto(proof: Image, listing: Image[]) {
  const { output } = await generateText({
    model: model(),
    system:
      "You verify that an artisan physically has a product. The FIRST image is a fresh proof photo: the product next to a paper with a handwritten code. Any further images are the product's listing photos. Report only what you see.",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Proof photo:" },
          { type: "image", image: proof.data, mediaType: proof.mediaType },
          ...(listing.length ? [{ type: "text" as const, text: "Listing photos:" }] : []),
          ...listing.slice(0, 2).map((l) => ({ type: "image" as const, image: l.data, mediaType: l.mediaType })),
        ],
      },
    ],
    output: Output.object({ schema: ProofRead, name: "proof_read" }),
  });
  if (!output) throw new Error("no proof analysis");
  return output;
}

export function codeMatches(handwritten: string, code: string): { digits: boolean; word: boolean } {
  const [wordHi, digits] = code.split(" ");
  const seenDigits = handwritten.replace(/[०-९]/g, (c) => String(c.charCodeAt(0) - 0x0966)).replace(/\D/g, "");
  return { digits: seenDigits.includes(digits), word: matchesCodeWord(handwritten, wordHi) };
}

// ── Check 2: not a mass-market product ──────────────────────────────────────

type Candidate = { title: string; domain: string; priceCents: number; url: string; image: string };

async function channel3ImageSearch(image: Image): Promise<Candidate[] | null> {
  const key = env().CHANNEL3_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.trychannel3.com/v1/search", {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        base64_image: Buffer.from(image.data).toString("base64"),
        limit: 6,
        config: { country: "US", currency: "USD" },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn(`[passport] channel3 image search ${res.status}: ${(await res.text()).slice(0, 160)}`);
      return null;
    }
    const data = (await res.json()) as {
      products: { title: string; images?: { url: string; cleaned_url?: string | null }[]; offers?: { url: string; domain: string; price?: { price: number } }[] }[];
    };
    return data.products.flatMap((p) => {
      const offer = p.offers?.[0];
      const img = p.images?.[0];
      return offer && img ? [{ title: p.title, domain: offer.domain, priceCents: Math.round((offer.price?.price ?? 0) * 100), url: offer.url, image: img.cleaned_url ?? img.url }] : [];
    });
  } catch (e) {
    console.warn("[passport] channel3 image search failed:", (e as Error).message);
    return null;
  }
}

const SameProduct = z.object({
  identicalIndex: z.number().int().describe("0-based index of a candidate that is the SAME mass-produced product (same design, not just similar style); -1 if none."),
  reason: z.string().max(200),
});

export async function checkMassMarket(image: Image) {
  const candidates = await channel3ImageSearch(image);
  if (!candidates) return { available: false as const };
  if (candidates.length === 0) return { available: true as const, match: null, searched: 0 };
  const { output } = await generateText({
    model: model(),
    system:
      "Decide whether a handmade listing is actually a mass-produced retail product. Similar style is normal for crafts and does NOT count — only the same design/print/item does.",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Listing photo:" },
          { type: "image", image: image.data, mediaType: image.mediaType },
          ...candidates.flatMap((c, i) => [
            { type: "text" as const, text: `Candidate ${i}: ${c.title} (${c.domain})` },
            { type: "image" as const, image: new URL(c.image) },
          ]),
        ],
      },
    ],
    output: Output.object({ schema: SameProduct, name: "same_product" }),
  }).catch((e) => {
    console.warn("[passport] candidate comparison failed:", (e as Error).message);
    return { output: null };
  });
  if (!output) return { available: false as const };
  const match = output.identicalIndex >= 0 ? (candidates[output.identicalIndex] ?? null) : null;
  return { available: true as const, match, reason: output.reason, searched: candidates.length };
}

// ── Check 3: original photos ────────────────────────────────────────────────

async function countOtherListings(productId: string) {
  const d = await db();
  const rows = await d.select({ id: schema.products.id }).from(schema.products);
  return rows.filter((r) => r.id !== productId).length;
}

async function findReusedPhotos(productId: string, hashes: string[]) {
  const d = await db();
  const others = await d
    .select({ id: schema.products.id, title: schema.products.title, images: schema.products.images })
    .from(schema.products);
  const otherMediaIds = others.filter((p) => p.id !== productId).flatMap((p) => p.images.map((m) => ({ m, p })));
  if (!otherMediaIds.length) return [];
  const rows = await d
    .select({ id: schema.media.id, dhash: schema.media.dhash })
    .from(schema.media)
    .where(and(inArray(schema.media.id, otherMediaIds.map((o) => o.m)), isNotNull(schema.media.dhash)));
  const hits = new Map<string, string>();
  for (const r of rows) {
    if (hashes.some((h) => hamming(h, r.dhash!) <= SAME_PHOTO_MAX_DISTANCE)) {
      const owner = otherMediaIds.find((o) => o.m === r.id)!.p;
      hits.set(owner.id, owner.title);
    }
  }
  return [...hits].map(([id, title]) => ({ productId: id, title }));
}


/** What Maker Evidence does NOT show — displayed in the UI, MCP and the signed record. */
export const EVIDENCE_LIMITATION = {
  en: "Evidence that the maker had this piece in hand recently and that its photos are original. It is not proof of who made it or how it was made.",
  hi: "यह सबूत है कि यह सामान हाल में कारीगर के पास था और फ़ोटो असली हैं। इससे यह साबित नहीं होता कि इसे किसने और कैसे बनाया।",
};

export type EvidenceResults = {
  possession: "passed" | "failed" | "uncertain";
  retail: "no_match" | "possible_match" | "not_run";
  photos: "no_similar_found" | "similar_found";
  photosScope: number; // how many other Haat listings were compared
};

/** Each check's actual result — never inferred from the overall status. */
export function evidenceResults(i: DecisionInput & { listingsChecked: number }): EvidenceResults {
  const failed = !i.read.paperWithWritingVisible || !i.codeMatch.digits || i.read.sameItemAsListing === "no";
  const uncertain = i.read.sameItemAsListing === "unsure" || i.read.photoOfScreenOrPrint;
  return {
    possession: failed ? "failed" : uncertain ? "uncertain" : "passed",
    retail: !i.market.available ? "not_run" : i.market.match ? "possible_match" : "no_match",
    photos: i.reused.length ? "similar_found" : "no_similar_found",
    photosScope: i.listingsChecked,
  };
}

export type DecisionInput = {
  code: string;
  read: z.infer<typeof ProofRead>;
  codeMatch: { digits: boolean; word: boolean };
  market: { available: boolean; match?: { domain: string; title: string } | null };
  reused: { productId: string; title: string }[];
};

/** Pure decision: hard failures reject; soft signals hold for review; otherwise verified. */
export function decidePassport({ code: issued, read, codeMatch: code, market, reused }: DecisionInput) {
  const passport = { code: issued };
  const problems: Flag[] = [];
  const reviews: Flag[] = [];
  if (!read.paperWithWritingVisible || !code.digits) {
    problems.push({
      code: "code_not_found",
      hi: `फ़ोटो में काग़ज़ पर कोड “${passport.code}” साफ़ नहीं दिखा। कोड बड़े अक्षरों में लिखकर, सामान के बगल में रखकर फिर फ़ोटो लें।`,
      en: `The code “${passport.code}” wasn't readable on paper next to the piece. Write it large and retake the photo.`,
    });
  }
  if (read.photoOfScreenOrPrint) {
    // A soft signal (dim or flat phone photos can trip it), so hold for review rather than reject.
    // The one-time handwritten code is the actual proof of possession.
    reviews.push({ code: "screen_photo", hi: "यह किसी स्क्रीन या छपी हुई तस्वीर की फ़ोटो लग रही है। असली सामान की, रोशनी में फ़ोटो लें।", en: "This may be a photo of a screen or print — held for review. Retake in daylight." });
  }
  if (read.sameItemAsListing === "no") {
    problems.push({ code: "different_item", hi: "फ़ोटो वाला सामान लिस्टिंग वाले सामान से अलग लगता है।", en: "The piece in the proof photo looks different from the listing." });
  } else if (read.sameItemAsListing === "unsure") {
    reviews.push({ code: "item_unclear", hi: "सामान साफ़ नहीं दिखा — पूरे सामान की फ़ोटो लें।", en: "Couldn't confirm it's the same piece — show the whole item." });
  }
  if (!market.available) {
    reviews.push({
      code: "retail_not_run",
      hi: "दुकानों में मिलती-जुलती चीज़ की जाँच अभी नहीं हो पाई। थोड़ी देर बाद फिर कोशिश करें।",
      en: "The retail search couldn't run, so this evidence is incomplete. Try again later.",
    });
  }
  if (market.available && market.match) {
    reviews.push({
      code: "mass_market_match",
      hi: `यही चीज़ ${market.match.domain} पर बिकती दिखी। अगर यह आपका अपना बनाया है, तो हम जाँच करेंगे।`,
      en: `The same item appears on ${market.match.domain} (“${market.match.title}”). Held for review.`,
    });
  }
  if (reused.length) {
    reviews.push({ code: "reused_photo", hi: "यह फ़ोटो किसी दूसरी लिस्टिंग में भी इस्तेमाल हुई है।", en: `A photo matches another listing (${reused[0].title}).` });
  }
  const status = problems.length ? "rejected" : reviews.length ? "needs_review" : "verified";
  return { status, problems, reviews } as const;
}

// ── Orchestration ───────────────────────────────────────────────────────────

export async function submitProof(productId: string, storeId: string, proof: Image) {
  const d = await db();
  const product = await loadProduct(productId, storeId);
  const [passport] = await d.select().from(schema.passports).where(eq(schema.passports.productId, productId));
  if (!passport) throw new PassportError("start verification first", 409);
  if (passport.status === "verified") throw new PassportError("already verified", 409);
  if (Date.now() - passport.codeIssuedAt.getTime() > CODE_TTL_MS) throw new PassportError("code expired — get a new one", 410);

  const proofHash = await dHash(proof.data);
  const [proofMedia] = await d
    .insert(schema.media)
    .values({ storeId, kind: "image", mediaType: proof.mediaType, bytes: proof.data, dhash: proofHash, sha256: sha256Hex(proof.data) })
    .returning({ id: schema.media.id });

  const listingRows = product.images.length
    ? await d.select().from(schema.media).where(inArray(schema.media.id, product.images))
    : [];
  const listing = listingRows.map((m) => ({ data: m.bytes, mediaType: m.mediaType }));
  const listingHashes = await Promise.all(listingRows.map(async (m) => m.dhash ?? dHash(m.bytes)));

  const [read, market, reused, listingsChecked] = await Promise.all([
    readProofPhoto(proof, listing),
    checkMassMarket(listing[0] ?? proof),
    findReusedPhotos(productId, [proofHash, ...listingHashes]),
    countOtherListings(productId),
  ]);
  const code = codeMatches(read.handwrittenText, passport.code);

  // ── Decision (deterministic) ──
  const { status, problems, reviews } = decidePassport({ code: passport.code, read, codeMatch: code, market, reused });

  const results = evidenceResults({ code: passport.code, read, codeMatch: code, market, reused, listingsChecked });
  const checks = {
    results,
    possession: { codeDigits: code.digits, codeWord: code.word, sameItem: read.sameItemAsListing, possibleScreenPhoto: read.photoOfScreenOrPrint, notes: read.notes },
    retail: market.available ? { searched: market.searched, match: market.match ?? null } : { searched: 0, match: null },
    photos: { comparedWithListings: listingsChecked, similarTo: reused },
    flags: [...problems, ...reviews],
    limitation: EVIDENCE_LIMITATION,
  };

  let payload: Record<string, unknown> | null = null;
  let signature: string | null = null;
  const verifiedAt = status === "verified" ? new Date() : null;
  if (status === "verified") {
    const [store] = await d.select().from(schema.stores).where(eq(schema.stores.id, storeId));
    payload = {
      v: 1,
      passportId: passport.id,
      productId,
      title: product.title,
      maker: store.ownerName,
      shop: store.slug,
      verifiedAt: verifiedAt!.toISOString(),
      proofPhotoSha256: sha256Hex(proof.data),
      listingPhotosSha256: listingRows.map((m) => m.sha256 ?? sha256Hex(m.bytes)),
      evidence: results,
      limitation: EVIDENCE_LIMITATION.en,
    };
    signature = signPayload(payload);
  }

  const [updated] = await d
    .update(schema.passports)
    .set({ proofMediaId: proofMedia.id, status, checks, payload, signature, verifiedAt })
    .where(eq(schema.passports.id, passport.id))
    .returning();
  return updated;
}

export async function getPassportsFor(productIds: string[]) {
  if (!productIds.length) return new Map<string, typeof schema.passports.$inferSelect>();
  const d = await db();
  const rows = await d.select().from(schema.passports).where(inArray(schema.passports.productId, productIds));
  return new Map(rows.map((r) => [r.productId, r]));
}
