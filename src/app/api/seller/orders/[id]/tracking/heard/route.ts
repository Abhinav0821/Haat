import { requireSeller } from "@/lib/auth/seller";
import { heardTracking } from "@/lib/autopilot/tracking";

/** Understand a spoken (or typed) courier + tracking number. Nothing is sent to PayPal yet. */
const AUDIO = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/aac"]);

export async function POST(request: Request) {
  const denied = await requireSeller(request);
  if (denied) return denied;
  const form = await request.formData().catch(() => null);
  if (!form) return Response.json({ error: "expected multipart/form-data" }, { status: 400 });
  const text = typeof form.get("text") === "string" ? String(form.get("text")).slice(0, 200) : undefined;
  const file = form.get("audio");
  let audio: { data: Uint8Array; mediaType: string } | undefined;
  if (file instanceof File && file.size > 0) {
    if (!AUDIO.has(file.type) || file.size > 4 * 1024 * 1024) return Response.json({ error: "unsupported audio" }, { status: 400 });
    audio = { data: new Uint8Array(await file.arrayBuffer()), mediaType: file.type };
  }
  if (!text && !audio) return Response.json({ error: "say or type the tracking number" }, { status: 400 });
  try {
    return Response.json(await heardTracking({ text, audio }));
  } catch (e) {
    console.error("[tracking heard] failed:", e);
    return Response.json({ error: "Couldn't understand that — please try again." }, { status: 503 });
  }
}
