import { requireSeller } from "@/lib/auth/seller";
import { AgreementError } from "@/lib/custom/agreement";
import { errorResponse } from "@/lib/custom/http";
import { declineRequest, draftAnswer, loadRequest, sellerApprove, sellerView, sendOptions } from "@/lib/custom/requests";
import { getDemoStore } from "@/lib/store";

const AUDIO = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/aac"]);

async function ownRequest(id: string) {
  const [store, r] = await Promise.all([getDemoStore(), loadRequest(id)]);
  if (r.storeId !== store.id) throw new AgreementError("request not found", 404);
}

/** The maker's side of one custom request: costs, earnings and capacity included. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireSeller(request);
  if (denied) return denied;
  const { id } = await params;
  try {
    await ownRequest(id);
    return Response.json(await sellerView(id));
  } catch (e) {
    return errorResponse(e, "seller custom view");
  }
}

/**
 * multipart (audio | text) → her spoken answer becomes checked DRAFT options.
 * JSON {action: "send", indexes} | {action: "approve", agreementId, hash} | {action: "decline"}.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireSeller(request);
  if (denied) return denied;
  const { id } = await params;
  try {
    await ownRequest(id);
    if ((request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
      const form = await request.formData();
      const text = typeof form.get("text") === "string" ? String(form.get("text")).slice(0, 1500) : undefined;
      const file = form.get("audio");
      let audio: { data: Uint8Array; mediaType: string } | undefined;
      if (file instanceof File && file.size > 0) {
        if (!AUDIO.has(file.type) || file.size > 8 * 1024 * 1024) return Response.json({ error: "unsupported audio" }, { status: 400 });
        audio = { data: new Uint8Array(await file.arrayBuffer()), mediaType: file.type };
      }
      if (!text && !audio) return Response.json({ error: "say or type your answer" }, { status: 400 });
      const drafted = await draftAnswer(id, { text, audio });
      return Response.json({ ...drafted, view: await sellerView(id) });
    }
    const body = (await request.json().catch(() => null)) as { action?: string; indexes?: number[]; agreementId?: string; hash?: string } | null;
    if (body?.action === "send") await sendOptions(id, (body.indexes ?? []).map(Number));
    else if (body?.action === "approve") await sellerApprove(id, String(body.agreementId), String(body.hash));
    else if (body?.action === "decline") await declineRequest(id);
    else return Response.json({ error: "unknown action" }, { status: 400 });
    return Response.json(await sellerView(id));
  } catch (e) {
    return errorResponse(e, "seller custom action");
  }
}
