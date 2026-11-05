import { MessageError, postSellerReply } from "@/lib/messages";

/** Seller reply by text or voice (multipart: text and/or audio). Translated to English for the buyer. */
const AUDIO = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/aac"]);

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "not found" }, { status: 404 });

  const form = await request.formData().catch(() => null);
  if (!form) return Response.json({ error: "expected multipart/form-data" }, { status: 400 });
  const text = typeof form.get("text") === "string" ? String(form.get("text")) : undefined;
  const file = form.get("audio");
  let audio: { data: Uint8Array; mediaType: string } | undefined;
  if (file instanceof File && file.size > 0) {
    if (!AUDIO.has(file.type) || file.size > 8 * 1024 * 1024) return Response.json({ error: "unsupported audio" }, { status: 400 });
    audio = { data: new Uint8Array(await file.arrayBuffer()), mediaType: file.type };
  }

  try {
    const reply = await postSellerReply(id, { text, audio });
    return Response.json({ reply: { id: reply.id, text: reply.originalText, english: reply.translatedText } }, { status: 201 });
  } catch (e) {
    if (e instanceof MessageError) return Response.json({ error: e.message }, { status: e.status });
    console.error("[seller reply] failed:", e);
    return Response.json({ error: "Couldn't send right now — please try again in a minute." }, { status: 503 });
  }
}
