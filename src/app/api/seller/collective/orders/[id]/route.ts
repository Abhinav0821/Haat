import { requireSeller } from "@/lib/auth/seller";
import { errorResponse } from "@/lib/custom/http";
import { getDemoCollective } from "@/lib/collective/demo";
import { CollectiveError, excludeMember, offerPlan, type Choice } from "@/lib/collective/service";
import { internalView } from "@/lib/collective/views";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";

const CHOICES = new Set<Choice>(["primary", "lowest_price", "within_budget", "largest_by_date", "earliest"]);

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
    return Response.json(await internalView(id));
  } catch (e) {
    return errorResponse(e, "collective order view");
  }
}

/** {action: "offer", choice} — send a checked plan to the makers; {action: "exclude", memberId} — leave out a maker who said no. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireSeller(request);
  if (denied) return denied;
  const { id } = await params;
  try {
    await own(id);
    const body = (await request.json().catch(() => null)) as { action?: string; choice?: Choice; memberId?: string } | null;
    if (body?.action === "offer" && body.choice && CHOICES.has(body.choice)) await offerPlan(id, body.choice);
    else if (body?.action === "exclude" && body.memberId) await excludeMember(id, body.memberId);
    else return Response.json({ error: "unknown action" }, { status: 400 });
    return Response.json(await internalView(id));
  } catch (e) {
    return errorResponse(e, "collective order action");
  }
}
