import { requireSeller } from "@/lib/auth/seller";
import { readEconomics } from "@/lib/economics";
import { env } from "@/lib/env";
import { hearRules, mergeRules, rulesReadbackHi } from "@/lib/ai/rules";
import { getDemoStore } from "@/lib/store";

/** Spoken/typed rules → a DRAFT merged with the current rules, plus a Hindi read-back. Not saved. */
const AUDIO = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/aac"]);

export async function POST(request: Request) {
  const denied = await requireSeller(request);
  if (denied) return denied;
  const form = await request.formData().catch(() => null);
  if (!form) return Response.json({ error: "expected multipart/form-data" }, { status: 400 });
  const text = typeof form.get("text") === "string" ? String(form.get("text")).slice(0, 1500) : undefined;
  const file = form.get("audio");
  let audio: { data: Uint8Array; mediaType: string } | undefined;
  if (file instanceof File && file.size > 0) {
    if (!AUDIO.has(file.type) || file.size > 8 * 1024 * 1024) return Response.json({ error: "unsupported audio" }, { status: 400 });
    audio = { data: new Uint8Array(await file.arrayBuffer()), mediaType: file.type };
  }
  if (!text && !audio) return Response.json({ error: "say or type your rules" }, { status: 400 });
  try {
    const store = await getDemoStore();
    const heard = await hearRules({ text, audio });
    const draft = mergeRules(readEconomics(store.policy), heard, env().INR_PER_USD);
    return Response.json({ heard: heard.transcript, draft, readback: rulesReadbackHi(draft) });
  } catch (e) {
    console.error("[rules draft] failed:", e);
    return Response.json({ error: "समझ नहीं पाई — एक मिनट बाद फिर बोलिए · Please try again" }, { status: 503 });
  }
}
