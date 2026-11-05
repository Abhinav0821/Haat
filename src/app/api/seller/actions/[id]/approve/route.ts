import { approveWithCodeWord, AutopilotError } from "@/lib/autopilot/refunds";

/** Approve a refund by saying (audio) or typing the code word. */
const AUDIO = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/aac"]);

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const form = await request.formData().catch(() => null);
  if (!form) return Response.json({ error: "expected multipart/form-data" }, { status: 400 });
  const typed = typeof form.get("word") === "string" ? String(form.get("word")).slice(0, 100) : undefined;
  const file = form.get("audio");
  let audio: { data: Uint8Array; mediaType: string } | undefined;
  if (file instanceof File && file.size > 0) {
    if (!AUDIO.has(file.type) || file.size > 4 * 1024 * 1024) return Response.json({ error: "unsupported audio" }, { status: 400 });
    audio = { data: new Uint8Array(await file.arrayBuffer()), mediaType: file.type };
  }
  if (!typed && !audio) return Response.json({ error: "say or type the code word" }, { status: 400 });
  try {
    const r = await approveWithCodeWord(id, { typed, audio });
    return Response.json(
      r.approved
        ? { approved: true, heard: r.heard, action: { id: r.action.id, status: r.action.status, result: r.action.result } }
        : r,
    );
  } catch (e) {
    if (e instanceof AutopilotError) return Response.json({ error: e.message }, { status: e.status });
    console.error("[approve] failed:", e);
    return Response.json({ error: "Couldn't check that right now — please try again." }, { status: 503 });
  }
}
