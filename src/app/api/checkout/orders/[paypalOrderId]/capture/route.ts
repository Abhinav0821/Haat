import { captureCheckoutOrder, CheckoutError } from "@/lib/paypal/orders";

/** POST → captures an approved PayPal order. Idempotent. */
export async function POST(_request: Request, { params }: { params: Promise<{ paypalOrderId: string }> }) {
  const { paypalOrderId } = await params;
  try {
    const result = await captureCheckoutOrder(paypalOrderId);
    return Response.json(result);
  } catch (e) {
    if (e instanceof CheckoutError) return Response.json({ error: e.message }, { status: e.status });
    console.error("[checkout] capture failed:", e);
    return Response.json({ error: "Payment could not be completed" }, { status: 502 });
  }
}
