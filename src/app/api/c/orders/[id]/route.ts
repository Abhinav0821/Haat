import { errorResponse } from "@/lib/custom/http";
import { createCollectiveCheckout } from "@/lib/collective/checkout";
import { env } from "@/lib/env";
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

/**
 * {action: "approve", planId, hash} — approve exactly the terms shown; capacity is reserved in the same step.
 * {action: "checkout", planId, hash} — a PayPal order for exactly those approved terms (returns approveUrl).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = (await request.json().catch(() => null)) as { action?: string; planId?: string; hash?: string } | null;
    if ((body?.action !== "approve" && body?.action !== "checkout") || typeof body.planId !== "string" || typeof body.hash !== "string") {
      return Response.json({ error: "unknown action" }, { status: 400 });
    }
    const view = await buyerView(id);
    if (view.offer?.id !== body.planId) return Response.json({ error: "These terms were replaced by a newer version. Please review the latest terms." }, { status: 409 });
    if (body.action === "checkout") return Response.json(await createCollectiveCheckout(id, body.planId, body.hash, { appUrl: env().APP_URL }));
    await buyerApprove(body.planId, body.hash);
    return Response.json(await buyerView(id));
  } catch (e) {
    return errorResponse(e, "collective buyer approve");
  }
}
