import { z } from "zod";
import { askHaat, transcribe, type Turn } from "@/lib/ask/agent";
import { requireSeller } from "@/lib/auth/seller";
import { getDemoStore } from "@/lib/store";

/** Ask Haat: multipart with `audio` (spoken question) or `text`, plus `history` (JSON turns). */
const AUDIO = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/aac"]);
const History = z.array(z.object({ role: z.enum(["seller", "haat"]), text: z.string().max(2000) })).max(20);

export async function POST(request: Request) {
  const denied = await requireSeller(request);
  if (denied) return denied;
  const form = await request.formData().catch(() => null);
  if (!form) return Response.json({ error: "expected multipart/form-data" }, { status: 400 });

  const history = History.safeParse(JSON.parse(String(form.get("history") ?? "[]") || "[]"));
  const typed = typeof form.get("text") === "string" ? String(form.get("text")).trim().slice(0, 1000) : "";
  const file = form.get("audio");

  try {
    let heard = typed;
    if (!heard && file instanceof File && file.size > 0) {
      if (!AUDIO.has(file.type) || file.size > 8 * 1024 * 1024) return Response.json({ error: "unsupported audio" }, { status: 400 });
      heard = await transcribe({ data: new Uint8Array(await file.arrayBuffer()), mediaType: file.type });
    }
    if (!heard) return Response.json({ error: "कुछ सुनाई नहीं दिया · Didn't catch that" }, { status: 400 });

    const store = await getDemoStore();
    const { replyHi, cards } = await askHaat({ storeId: store.id, question: heard, history: history.success ? (history.data as Turn[]) : [] });
    return Response.json({ heard, replyHi, cards });
  } catch (e) {
    console.error("[ask] failed:", e);
    return Response.json({ error: "अभी जवाब नहीं दे पा रही — एक मिनट बाद फिर पूछिए · Please try again in a minute" }, { status: 503 });
  }
}
