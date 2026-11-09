import { requireSeller } from "@/lib/auth/seller";
import { errorResponse } from "@/lib/custom/http";
import { getDemoCollective, membersOf } from "@/lib/collective/demo";
import { materialsReadyOn, MemberFactsSchema } from "@/lib/collective/facts";
import { newMemberLink } from "@/lib/collective/seed";
import { CollectiveError, createOrder, setMemberLanguage, settingsOf, updateMemberFacts } from "@/lib/collective/service";
import { listOrders } from "@/lib/collective/views";
import { db } from "@/db";

/** The coordinator's view of the collective: makers (facts + provenance), orders. */
export async function GET(request: Request) {
  const denied = await requireSeller(request);
  if (denied) return denied;
  try {
    const c = await getDemoCollective();
    const members = await membersOf(c.id);
    return Response.json({
      collective: { id: c.id, slug: c.slug, name: c.name, coordinatorName: c.coordinatorName, settings: settingsOf(c) },
      members: members.map((m) => {
        const facts = MemberFactsSchema.parse(m.facts);
        return { id: m.id, name: m.name, nameHi: m.nameHi, language: m.language, facts: { ...facts, materialsReadyDate: materialsReadyOn(facts) } };
      }),
      orders: await listOrders(c.id),
    });
  } catch (e) {
    return errorResponse(e, "collective view");
  }
}

/**
 * {action: "order", buyerText, buyerName?, quantity, deadline, budgetUsd?, details?} — record a buyer's request
 * {action: "link", memberId} — a new personal link for a maker (shown once; the old one stops working)
 * {action: "facts", memberId, facts} — coordinator-entered facts (an estimate until she confirms them)
 * {action: "language", memberId, language} — her language (she can change it on her own link too)
 */
export async function POST(request: Request) {
  const denied = await requireSeller(request);
  if (denied) return denied;
  try {
    const c = await getDemoCollective();
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const own = async (memberId: unknown) => {
      const m = (await membersOf(c.id)).find((x) => x.id === memberId);
      if (!m) throw new CollectiveError("maker not found", 404);
      return m;
    };
    if (body?.action === "order") {
      const budget = body.budgetUsd === null || body.budgetUsd === undefined || body.budgetUsd === "" ? null : Math.round(Number(body.budgetUsd) * 100);
      const o = await createOrder(c.id, {
        buyerText: String(body.buyerText ?? "").trim() || `${body.quantity} × ${settingsOf(c).product.en}`,
        buyerName: body.buyerName ? String(body.buyerName).slice(0, 80) : null,
        spec: { quantity: Number(body.quantity), deadline: String(body.deadline ?? ""), budgetUsdCents: budget, details: body.details ? String(body.details) : null, detailsHi: body.detailsHi ? String(body.detailsHi) : null },
      });
      return Response.json({ id: o.id });
    }
    if (body?.action === "link") {
      const m = await own(body.memberId);
      const token = await newMemberLink(await db(), m.id);
      return Response.json({ path: `/m/${token}` });
    }
    if (body?.action === "language") {
      const m = await own(body.memberId);
      await setMemberLanguage(m.id, body.language);
      return Response.json({ ok: true });
    }
    if (body?.action === "facts") {
      const m = await own(body.memberId);
      await updateMemberFacts(m.id, body.facts, { source: "coordinator_entered", name: c.coordinatorName });
      return Response.json({ ok: true });
    }
    return Response.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return errorResponse(e, "collective action");
  }
}
