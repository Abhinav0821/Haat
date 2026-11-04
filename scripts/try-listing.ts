/**
 * Try voice/photo → listing from the command line.
 *   npm run try:listing -- tests/fixtures/seller-note-hi.wav [photo.jpg ...]
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { draftListing, suggestUsdCents, type MediaInput } from "@/lib/ai/listing";
import { aiModelId } from "@/lib/ai/model";

const TYPES: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".webm": "audio/webm",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("usage: npm run try:listing -- <voice-note.wav> [photo.jpg ...]");
    process.exit(1);
  }
  const media: MediaInput[] = files.map((f) => {
    const mediaType = TYPES[extname(f).toLowerCase()];
    if (!mediaType) throw new Error(`unsupported file type: ${f}`);
    return { data: readFileSync(f), mediaType };
  });
  const audio = media.find((m) => m.mediaType.startsWith("audio/"));
  const images = media.filter((m) => m.mediaType.startsWith("image/"));

  const started = Date.now();
  const draft = await draftListing({ audio, images });
  console.log(`model ${aiModelId()} · ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  console.log(JSON.stringify(draft, null, 2));

  const rate = Number(process.env.INR_PER_USD ?? 88);
  const cents = suggestUsdCents(draft.statedPrice, rate);
  if (cents !== null) console.log(`\nSuggested price: $${(cents / 100).toFixed(2)} (at ₹${rate} per $1 — seller confirms)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
