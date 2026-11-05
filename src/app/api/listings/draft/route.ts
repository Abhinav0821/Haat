import { db, schema } from "@/db";
import { env } from "@/lib/env";
import { draftListing, suggestUsdCents, type MediaInput } from "@/lib/ai/listing";
import { analyzeFairPrice, selectComparables } from "@/lib/pricing/fair-price";
import { searchComparables } from "@/lib/pricing/channel3";
import { getDemoStore } from "@/lib/store";

/**
 * POST multipart/form-data: audio (optional), images[] (optional, ≤4), note (optional)
 * → AI draft listing + stored media ids. Nothing is published here.
 */

const MAX_AUDIO = 8 * 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_IMAGES = 4;
const AUDIO_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/aac", "audio/flac"]);
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function bad(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return bad("expected multipart/form-data");
  }

  const audioFile = form.get("audio");
  const imageFiles = form.getAll("images").filter((f): f is File => f instanceof File && f.size > 0);
  const note = typeof form.get("note") === "string" ? String(form.get("note")).slice(0, 2000) : undefined;

  if (imageFiles.length > MAX_IMAGES) return bad(`at most ${MAX_IMAGES} photos`);
  for (const f of imageFiles) {
    if (!IMAGE_TYPES.has(f.type)) return bad(`unsupported photo type ${f.type}`);
    if (f.size > MAX_IMAGE) return bad("photo too large (max 5 MB)");
  }
  let audio: MediaInput | undefined;
  if (audioFile instanceof File && audioFile.size > 0) {
    if (!AUDIO_TYPES.has(audioFile.type)) return bad(`unsupported audio type ${audioFile.type}`);
    if (audioFile.size > MAX_AUDIO) return bad("voice note too long");
    audio = { data: new Uint8Array(await audioFile.arrayBuffer()), mediaType: audioFile.type };
  }
  const images: MediaInput[] = await Promise.all(
    imageFiles.map(async (f) => ({ data: new Uint8Array(await f.arrayBuffer()), mediaType: f.type })),
  );
  if (!audio && images.length === 0 && !note) return bad("add a photo or a voice note");

  const store = await getDemoStore();
  const d = await db();

  // Keep the originals: photos go on the product page, the voice note powers "Meet the maker".
  const stored = await d
    .insert(schema.media)
    .values([
      ...(audio ? [{ storeId: store.id, kind: "audio" as const, mediaType: audio.mediaType, bytes: audio.data }] : []),
      ...images.map((i) => ({ storeId: store.id, kind: "image" as const, mediaType: i.mediaType, bytes: i.data })),
    ])
    .returning({ id: schema.media.id, kind: schema.media.kind });

  try {
    const draft = await draftListing({ audio, images, note });
    const inrPerUsd = env().INR_PER_USD;
    const suggestedPriceCents = suggestUsdCents(draft.statedPrice, inrPerUsd);

    // Fair-price coach: live comparables from Channel3, filtered to the same kind of item.
    const found = await searchComparables(draft.comparableSearch.query);
    const comparables = found ? selectComparables(found, draft.comparableSearch.typeKeywords) : [];
    const fairPrice = analyzeFairPrice(comparables, suggestedPriceCents);

    return Response.json({
      draft,
      voiceNoteId: stored.find((m) => m.kind === "audio")?.id ?? null,
      imageIds: stored.filter((m) => m.kind === "image").map((m) => m.id),
      suggestedPriceCents,
      inrPerUsd,
      fairPrice,
    });
  } catch (e) {
    console.error("[listings/draft] AI draft failed:", e);
    return bad("Couldn't understand that right now — please try again in a minute.", 503);
  }
}
