import { z } from "zod";
import { correctionReadbackHi, correctListing, suggestUsdCents } from "@/lib/ai/listing";
import { requireSeller } from "@/lib/auth/seller";
import { env } from "@/lib/env";
import { logEvent } from "@/lib/events";

/** Spoken correction to a draft listing → changed fields + Hindi read-back. Nothing is published. */
const Current = z.object({
  title: z.string().max(200),
  description: z.string().max(4000),
  priceUsd: z.string().max(20),
  attributes: z.object({
    materials: z.array(z.string()),
    colors: z.array(z.string()),
    dimensions: z.string().nullable(),
    origin: z.string().nullable(),
    handmade: z.boolean().nullable(),
    care: z.string().nullable(),
  }),
});
const AUDIO = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/aac"]);

export async function POST(request: Request) {
  const denied = await requireSeller(request);
  if (denied) return denied;
  const form = await request.formData().catch(() => null);
  if (!form) return Response.json({ error: "expected multipart/form-data" }, { status: 400 });
  const current = Current.safeParse(JSON.parse(String(form.get("current") ?? "null")));
  if (!current.success) return Response.json({ error: "invalid listing" }, { status: 400 });
  const text = typeof form.get("text") === "string" ? String(form.get("text")).slice(0, 500) : undefined;
  const file = form.get("audio");
  let audio: { data: Uint8Array; mediaType: string } | undefined;
  if (file instanceof File && file.size > 0) {
    if (!AUDIO.has(file.type) || file.size > 6 * 1024 * 1024) return Response.json({ error: "unsupported audio" }, { status: 400 });
    audio = { data: new Uint8Array(await file.arrayBuffer()), mediaType: file.type };
  }
  if (!text && !audio) return Response.json({ error: "say the correction" }, { status: 400 });
  try {
    const c = await correctListing(current.data, { text, audio });
    const priceUsdCents = c.price ? suggestUsdCents(c.price, env().INR_PER_USD) : null;
    await logEvent("listing_corrected_by_voice", { changed: Object.entries(c).filter(([k, v]) => k !== "transcript" && v !== null).map(([k]) => k) });
    return Response.json({ correction: c, priceUsdCents, readbackHi: correctionReadbackHi(c, priceUsdCents) });
  } catch (e) {
    console.error("[listing correct] failed:", e);
    return Response.json({ error: "समझ नहीं पाई — फिर से बोलिए · Please try again" }, { status: 503 });
  }
}
