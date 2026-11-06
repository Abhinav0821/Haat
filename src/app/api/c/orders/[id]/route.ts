import { errorResponse } from "@/lib/custom/http";
import { buyerApprove } from "@/lib/collective/service";
import { buyerView } from "@/lib/collective/views";

/** The buyer's view of a collective order: terms, dates, total — no maker's pay, minimum or availability. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return Response.json(await buyerView(id));
  } catch (e) {
    return errorResponse(e, "collective buyer view");
  }
}

/** {action: "approve", planId, hash} — approve exactly the terms shown; capacity is reserved in the same step. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = (await request.json().catch(() => null)) as { action?: string; planId?: string; hash?: string } | null;
    if (body?.action !== "approve" || !body.planId || !body.hash) return Response.json({ error: "unknown action" }, { status: 400 });
    const view = await buyerView(id);
    if (view.offer?.id !== body.planId) return Response.json({ error: "These terms were replaced by a newer version. Please review the latest terms." }, { status: 409 });
    await buyerApprove(body.planId, body.hash);
    return Response.json(await buyerView(id));
  } catch (e) {
    return errorResponse(e, "collective buyer approve");
  }
}
