import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { createAgreementCheckout } from "@/lib/custom/agreement";
import { errorResponse } from "@/lib/custom/http";
import { buyerApprove, buyerView, chooseOption, counterOffer, loadRequest } from "@/lib/custom/requests";
import { env } from "@/lib/env";

/**
 * The buyer's side of one custom request. The request id (a random UUID) is the
 * buyer's link to it. Never returns the maker's costs or earnings.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return Response.json(await buyerView(id));
  } catch (e) {
    return errorResponse(e, "custom view");
  }
}

type Body =
  | { action: "choose"; kind: "option" | "alternative"; index: number }
  | { action: "counter"; quantity: number; totalUsd: number }
  | { action: "approve"; agreementId: string; hash: string }
  | { action: "checkout" };

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as Body | null;
  try {
    switch (body?.action) {
      case "choose":
        await chooseOption(id, { kind: body.kind === "alternative" ? "alternative" : "option", index: Number(body.index) });
        break;
      case "counter": {
        const r = await counterOffer(id, { quantity: Number(body.quantity), totalBudgetUsdCents: Math.round(Number(body.totalUsd) * 100) });
        return Response.json({ ...(await buyerView(id)), counterAccepted: r.result.acceptable });
      }
      case "approve":
        await buyerApprove(id, String(body.agreementId), String(body.hash));
        break;
      case "checkout": {
        const view = await buyerView(id);
        if (!view.agreement) return Response.json({ error: "No agreement yet." }, { status: 409 });
        const r = await loadRequest(id);
        const d = await db();
        const [store] = await d.select().from(schema.stores).where(eq(schema.stores.id, r.storeId));
        const c = await createAgreementCheckout(view.agreement.id, { appUrl: env().APP_URL, storeSlug: store.slug });
        return Response.json(c);
      }
      default:
        return Response.json({ error: "unknown action" }, { status: 400 });
    }
    return Response.json(await buyerView(id));
  } catch (e) {
    return errorResponse(e, "custom action");
  }
}
