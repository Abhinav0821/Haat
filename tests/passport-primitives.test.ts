import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { dHash, hamming, SAME_PHOTO_MAX_DISTANCE } from "@/lib/passport/image-hash";
import { canonical, signPayload, verifyPayload } from "@/lib/passport/signing";

/** Synthetic "photos": smooth scenes with different structure per seed. */
async function photo(seed: number, quality = 90): Promise<Uint8Array> {
  const w = 240, h = 180;
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const v = Math.round(127 + 120 * Math.sin((x * (seed + 1)) / 37 + (y * (3 - seed)) / 29 + seed));
      px[i] = v;
      px[i + 1] = (v + 40 * seed) % 256;
      px[i + 2] = 255 - v;
    }
  return new Uint8Array(await sharp(px, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality }).toBuffer());
}

test("the same photo re-compressed and resized is still recognised", async () => {
  const original = await photo(0, 92);
  const recompressed = new Uint8Array(await sharp(original).resize(120).jpeg({ quality: 45 }).toBuffer());
  assert.ok(hamming(await dHash(original), await dHash(recompressed)) <= SAME_PHOTO_MAX_DISTANCE);
});

test("a genuinely different photo is not flagged", async () => {
  const d = hamming(await dHash(await photo(0)), await dHash(await photo(2)));
  assert.ok(d > SAME_PHOTO_MAX_DISTANCE, `distance ${d}`);
});

test("hamming distance basics", () => {
  assert.equal(hamming("0000000000000000", "0000000000000000"), 0);
  assert.equal(hamming("0000000000000000", "ffffffffffffffff"), 64);
  assert.equal(hamming("000000000000000f", "0000000000000001"), 3);
});

test("passport signatures verify, and any edit breaks them", () => {
  const payload = { productId: "p1", maker: "Meera", checks: { liveness: true, marketMatch: false }, verifiedAt: "2026-11-05" };
  const sig = signPayload(payload);
  assert.equal(verifyPayload(payload, sig), true);
  assert.equal(verifyPayload({ ...payload, maker: "Someone else" }, sig), false);
  assert.equal(verifyPayload({ ...payload, checks: { liveness: true, marketMatch: true } }, sig), false);
  assert.equal(verifyPayload(payload, sig.slice(0, -3) + "AAA"), false);
});

test("canonical JSON is key-order independent", () => {
  assert.equal(canonical({ b: 1, a: { d: [2, 1], c: "x" } }), canonical({ a: { c: "x", d: [2, 1] }, b: 1 }));
});

test("handwritten code: digits must match exactly (Western or Devanagari numerals)", async () => {
  const { codeMatches } = await import("@/lib/passport/passport");
  assert.deepEqual(codeMatches("कमल 4821", "कमल 4821"), { digits: true, word: true });
  assert.deepEqual(codeMatches("कमल ४८२१", "कमल 4821"), { digits: true, word: true });
  assert.equal(codeMatches("Kamal 4821", "कमल 4821").word, true);
  assert.equal(codeMatches("कमल 4812", "कमल 4821").digits, false, "transposed digits fail");
  assert.equal(codeMatches("", "कमल 4821").digits, false);
});

test("passport decision: every outcome", async () => {
  const { decidePassport } = await import("@/lib/passport/passport");
  const good = {
    code: "कमल 4821",
    read: { handwrittenText: "कमल 4821", paperWithWritingVisible: true, sameItemAsListing: "yes" as const, photoOfScreenOrPrint: false, notes: "" },
    codeMatch: { digits: true, word: true },
    market: { available: true, match: null },
    reused: [],
  };
  assert.equal(decidePassport(good).status, "verified");
  // Hard failures → rejected
  assert.equal(decidePassport({ ...good, codeMatch: { digits: false, word: true } }).status, "rejected");
  assert.equal(decidePassport({ ...good, read: { ...good.read, paperWithWritingVisible: false } }).status, "rejected");
  assert.equal(decidePassport({ ...good, read: { ...good.read, sameItemAsListing: "no" } }).status, "rejected");
  // Soft signals → held for review, never silently verified
  assert.equal(decidePassport({ ...good, read: { ...good.read, sameItemAsListing: "unsure" } }).status, "needs_review");
  assert.equal(decidePassport({ ...good, read: { ...good.read, photoOfScreenOrPrint: true } }).status, "needs_review");
  assert.equal(decidePassport({ ...good, market: { available: true, match: { domain: "bigstore.com", title: "Printed scarf" } } }).status, "needs_review");
  assert.equal(decidePassport({ ...good, reused: [{ productId: "x", title: "Other listing" }] }).status, "needs_review");
  // A hard failure wins over soft signals
  assert.equal(decidePassport({ ...good, codeMatch: { digits: false, word: false }, reused: [{ productId: "x", title: "y" }] }).status, "rejected");
  // Retail search being unavailable doesn't block an otherwise good proof
  assert.equal(decidePassport({ ...good, market: { available: false } }).status, "verified");
  // Every flag is bilingual
  for (const f of decidePassport({ ...good, codeMatch: { digits: false, word: false }, read: { ...good.read, photoOfScreenOrPrint: true } }).problems)
    assert.ok(f.hi && f.en);
});
