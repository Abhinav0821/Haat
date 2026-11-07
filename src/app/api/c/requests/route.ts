import { clientKeyOf } from "@/lib/auth/seller";
import { errorResponse } from "@/lib/custom/http";
import { hit } from "@/lib/rate-limit";
import { readBulkRequest } from "@/lib/ai/collective-intake";
import { getDemoCollective } from "@/lib/collective/demo";
import { InterpretationSchema } from "@/lib/collective/intake";
import { calendarDate } from "@/lib/collective/calendar";
import { CollectiveError, createBuyerRequest, earliestDelivery, settingsOf } from "@/lib/collective/service";

/** What the request page needs before anything is typed: who is asked, for what, and the earliest date. */
export async function GET() {
  try {
    const c = await getDemoCollective();
    const s = settingsOf(c);
    return Response.json({ collective: c.name, product: s.product.en, earliest: earliestDelivery(s, new Date()) });
  } catch (e) {
    return errorResponse(e, "collective request info");
  }
}

/**
 * {action: "read", text} — the AI's proposed reading of the buyer's words, grounded in code (nothing is stored).
 * {action: "send", text, quantity, deadline, budgetUsd?, details?, buyerName?, buyerEmail?, proposed?, via} —
 *   the requirements the buyer confirmed become the order. Returns the buyer's order page.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const key = clientKeyOf(request);
  try {
    const c = await getDemoCollective();
    const s = settingsOf(c);
    const now = new Date();
    if (body?.action === "read") {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (text.length < 5 || text.length > 2000) throw new CollectiveError("Describe your order in 5 to 2,000 characters.", 400);
      if (!(await hit(`c-read:${key}`, 8, 60 * 60_000))) return Response.json({ error: "Too many readings — please fill in the details yourself." }, { status: 429 });
      try {
        const out = await readBulkRequest(text, { today: calendarDate(now), earliest: earliestDelivery(s, now), inrPerUsd: s.inrPerUsd, product: s.product.en, collective: c.name });
        return Response.json(out);
      } catch (e) {
        console.warn("[collective intake] AI reading failed:", (e as Error).message.slice(0, 120));
        return Response.json({ error: "We couldn't read the request automatically just now. Please fill in the details yourself.", fallback: true }, { status: 503 });
      }
    }
    if (body?.action === "send") {
      if (!(await hit(`c-send:${key}`, 5, 60 * 60_000))) return Response.json({ error: "Too many requests — please try again later." }, { status: 429 });
      const budgetRaw = body.budgetUsd;
      const budget = budgetRaw === null || budgetRaw === undefined || budgetRaw === "" ? null : Math.round(Number(budgetRaw) * 100);
      if (budget !== null && !(Number.isSafeInteger(budget) && budget > 0)) throw new CollectiveError("The budget must be a positive amount in US dollars.", 400);
      const quantity = Number(body.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000) throw new CollectiveError("Quantity must be a whole number from 1 to 10,000.", 400);
      const proposed = InterpretationSchema.safeParse(body.proposed);
      const o = await createBuyerRequest(
        c,
        {
          text: typeof body.text === "string" ? body.text : "",
          buyerName: typeof body.buyerName === "string" ? body.buyerName : null,
          buyerEmail: typeof body.buyerEmail === "string" ? body.buyerEmail : null,
          channel: "web",
          via: body.via === "ai" && proposed.success ? "ai" : "form",
          model: typeof body.model === "string" ? body.model.slice(0, 80) : null,
          spec: { quantity, deadline: String(body.deadline ?? ""), budgetUsdCents: budget, details: typeof body.details === "string" ? body.details : null },
          proposed: proposed.success ? proposed.data : null,
        },
        now,
      );
      return Response.json({ id: o.id, url: `/c/orders/${o.id}` }, { status: 201 });
    }
    return Response.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return errorResponse(e, "collective request");
  }
}
