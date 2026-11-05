import { z } from "zod";
import { clientKeyOf } from "@/lib/auth/seller";
import { CheckoutError, createCheckoutOrder } from "@/lib/paypal/orders";
import { hit } from "@/lib/rate-limit";

/** POST { productId, quantity? } → { orderId } (PayPal order id, as the v6 SDK expects). */
const Body = z.object({ productId: z.string().uuid(), quantity: z.number().int().min(1).max(10).default(1) });

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid request" }, { status: 400 });
  // Each checkout holds a piece for 20 minutes; limit per client so a script can't hold her whole stock.
  if (!(await hit(`checkout:${clientKeyOf(request)}`, 10, 10 * 60_000))) {
    return Response.json({ error: "Too many checkout attempts — please wait a few minutes." }, { status: 429 });
  }
  try {
    const order = await createCheckoutOrder({ ...parsed.data, channel: "storefront" });
    return Response.json({ orderId: order.paypalOrderId }, { status: 201 });
  } catch (e) {
    if (e instanceof CheckoutError) return Response.json({ error: e.message }, { status: e.status });
    console.error("[checkout] create failed:", e);
    return Response.json({ error: "Could not start PayPal checkout" }, { status: 502 });
  }
}
