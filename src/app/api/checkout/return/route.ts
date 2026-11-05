import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import { captureCheckoutOrder } from "@/lib/paypal/orders";

/**
 * PayPal redirect target (?token=<PayPal order id>&PayerID=…). Used when a buyer
 * approves a checkout link an AI agent created for them. Captures, then shows
 * the order confirmation.
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  let destination = "/";
  try {
    const { orderId } = await captureCheckoutOrder(token);
    const d = await db();
    const [row] = await d
      .select({ slug: schema.stores.slug })
      .from(schema.orders)
      .innerJoin(schema.stores, eq(schema.stores.id, schema.orders.storeId))
      .where(eq(schema.orders.id, orderId));
    destination = row ? `/s/${row.slug}/order/${orderId}` : "/";
  } catch (e) {
    console.error("[checkout/return] capture failed:", e);
    destination = "/?checkout=failed";
  }
  redirect(destination);
}
