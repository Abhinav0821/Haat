import { requireSeller } from "@/lib/auth/seller";
import { errorResponse } from "@/lib/custom/http";
import { getDemoCollective } from "@/lib/collective/demo";
import { CollectiveError, excludeMember, exportEvaluationSnapshot, offerPlan, updateOrderRequirements, type Choice } from "@/lib/collective/service";
import { internalView } from "@/lib/collective/views";
import { reportMakerPayment, withdrawMakerPayment } from "@/lib/collective/payouts";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";

const CHOICES = new Set<Choice>(["primary", "lowest_price", "within_budget", "largest_by_date", "earliest", "keep_agreed"]);

async function own(id: string) {
  const c = await getDemoCollective();
  const [o] = await (await db()).select({ collectiveId: schema.collectiveOrders.collectiveId }).from(schema.collectiveOrders).where(eq(schema.collectiveOrders.id, id));
  if (!o || o.collectiveId !== c.id) throw new CollectiveError("order not found", 404);
}

/** Internal view: facts with provenance, the planner's checked answer, the plan, each maker's response. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireSeller(request);
  if (denied) return denied;
  const { id } = await params;
  try {
    await own(id);
    if (new URL(request.url).searchParams.get("export") === "evaluation") {
      return Response.json(await exportEvaluationSnapshot(id), { headers: { "Content-Disposition": `attachment; filename="evaluation-${id}.json"`, "Cache-Control": "private, no-store" } });
    }
    return Response.json(await internalView(id));
  } catch (e) {
    return errorResponse(e, "collective order view");
  }
}

/** A share or payment record of THIS order (never another order's, even with a valid id). */
async function ownShare(orderId: string, shareId: unknown) {
  const [s] = await (await db()).select({ orderId: schema.makerShares.orderId }).from(schema.makerShares).where(eq(schema.makerShares.id, String(shareId)));
  if (!s || s.orderId !== orderId) throw new CollectiveError("This share wasn't found.", 404);
}
async function ownPayment(orderId: string, paymentId: unknown) {
  const [p] = await (await db()).select({ orderId: schema.makerShares.orderId }).from(schema.makerPayments).innerJoin(schema.makerShares, eq(schema.makerShares.id, schema.makerPayments.shareId)).where(eq(schema.makerPayments.id, String(paymentId)));
  if (!p || p.orderId !== orderId) throw new CollectiveError("This payment record wasn't found.", 404);
}

/**
 * {action: "offer", choice} — send a checked plan to the makers; {action: "exclude", memberId} — leave out a maker who said no.
 * {action: "report_payment", shareId, amountInr, method: "upi"|"bank", reference} — a payment made to a maker (hers to confirm).
 * {action: "withdraw_payment", paymentId} — withdraw a record she hasn't confirmed.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireSeller(request);
  if (denied) return denied;
  const { id } = await params;
  try {
    await own(id);
    const body = (await request.json().catch(() => null)) as {
      action?: string; choice?: Choice; memberId?: string; details?: string | null; detailsHi?: string | null;
      shareId?: string; paymentId?: string; amountInr?: unknown; method?: unknown; reference?: unknown;
    } | null;
    if (body?.action === "offer" && body.choice && CHOICES.has(body.choice)) await offerPlan(id, body.choice);
    else if (body?.action === "exclude" && body.memberId) await excludeMember(id, body.memberId);
    else if (body?.action === "requirements") await updateOrderRequirements(id, body.details ?? null, body.detailsHi ?? null);
    else if (body?.action === "report_payment") {
      await ownShare(id, body.shareId);
      await reportMakerPayment(String(body.shareId), { amountInr: body.amountInr, method: body.method, reference: body.reference }, { name: (await getDemoCollective()).coordinatorName });
    } else if (body?.action === "withdraw_payment") {
      await ownPayment(id, body.paymentId);
      await withdrawMakerPayment(String(body.paymentId));
    }
    else return Response.json({ error: "unknown action" }, { status: 400 });
    return Response.json(await internalView(id));
  } catch (e) {
    return errorResponse(e, "collective order action");
  }
}
