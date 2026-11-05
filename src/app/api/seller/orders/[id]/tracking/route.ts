import { requireSeller } from "@/lib/auth/seller";
import { z } from "zod";
import { addTrackingToOrder, CARRIERS, type CarrierKey } from "@/lib/autopilot/tracking";

/** Seller confirmed the read-back → add tracking on PayPal. */
const Body = z.object({
  carrier: z.enum(Object.keys(CARRIERS) as [CarrierKey, ...CarrierKey[]]),
  trackingNumber: z.string().min(6).max(40),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireSeller(request);
  if (denied) return denied;
  const { id } = await params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "invalid request" }, { status: 400 });
  try {
    const order = await addTrackingToOrder(id, parsed.data.carrier, parsed.data.trackingNumber);
    return Response.json({ ok: true, trackingNumber: order.trackingNumber, carrier: order.trackingCarrier });
  } catch (e) {
    console.error("[tracking] failed:", e);
    return Response.json({ error: (e as Error).message }, { status: 422 });
  }
}
