import { errorResponse } from "@/lib/custom/http";
import { memberByLink, respondToPart, updateMemberFacts } from "@/lib/collective/service";
import { makerView } from "@/lib/collective/views";

/** A maker's own page, behind her personal link: her parts and her facts, nothing about anyone else. */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    return Response.json(await makerView(token));
  } catch (e) {
    return errorResponse(e, "maker view");
  }
}

/** {action: "respond", partId, hash, answer: "accept"|"decline", note?} | {action: "facts", facts} */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const body = (await request.json().catch(() => null)) as { action?: string; partId?: string; hash?: string; answer?: string; note?: string; facts?: unknown } | null;
    if (body?.action === "respond" && (body.answer === "accept" || body.answer === "decline")) {
      await respondToPart(token, String(body.partId), String(body.hash), body.answer, body.note ? String(body.note) : null);
    } else if (body?.action === "facts") {
      const m = await memberByLink(token);
      await updateMemberFacts(m.id, body.facts, { source: "maker_confirmed", name: m.name });
    } else return Response.json({ error: "unknown action" }, { status: 400 });
    return Response.json(await makerView(token));
  } catch (e) {
    return errorResponse(e, "maker action");
  }
}
