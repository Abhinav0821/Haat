import { errorResponse } from "@/lib/custom/http";
import { memberByLink, respondToPart, setMemberLanguage, updateMemberFacts } from "@/lib/collective/service";
import { makerView } from "@/lib/collective/views";
import { respondToPayment } from "@/lib/collective/payouts";

/** A maker's own page, behind her personal link: her parts and her facts, nothing about anyone else. */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    return Response.json(await makerView(token));
  } catch (e) {
    return errorResponse(e, "maker view");
  }
}

/**
 * {action: "respond", partId, hash, answer: "accept"|"decline", note?} | {action: "facts", facts}
 * {action: "payment", paymentId, answer: "confirm"|"dispute", note?} — did a reported payment reach her?
 * {action: "language", language} — her language for this page and future parts
 */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const body = (await request.json().catch(() => null)) as { action?: string; partId?: string; paymentId?: string; hash?: string; answer?: string; note?: string; facts?: unknown; language?: unknown } | null;
    if (body?.action === "respond" && (body.answer === "accept" || body.answer === "decline")) {
      await respondToPart(token, String(body.partId), String(body.hash), body.answer, body.note ? String(body.note) : null);
    } else if (body?.action === "payment" && (body.answer === "confirm" || body.answer === "dispute")) {
      await respondToPayment(token, String(body.paymentId), body.answer, body.note ? String(body.note) : null);
    } else if (body?.action === "language") {
      // Her own choice, on her own link. Parts already sent keep the language they were made in.
      await setMemberLanguage((await memberByLink(token)).id, body.language);
    } else if (body?.action === "facts") {
      const m = await memberByLink(token);
      await updateMemberFacts(m.id, body.facts, { source: "maker_confirmed", name: m.name });
    } else return Response.json({ error: "unknown action" }, { status: 400 });
    return Response.json(await makerView(token));
  } catch (e) {
    return errorResponse(e, "maker action");
  }
}
