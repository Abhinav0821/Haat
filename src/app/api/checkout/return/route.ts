import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import { captureCheckoutOrder } from "@/lib/paypal/orders";

/**
 * PayPal redirect target (?token=<PayPal order id>&PayerID=…). Used when a buyer
 * approves a checkout link an AI agent created for them, and for custom-order
 * agreements. Captures, then shows the confirmation (or the agreement page).
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  let failed = false;
  try {
    await captureCheckoutOrder(token);
  } catch (e) {
    console.error("[checkout/return] capture failed:", e);
    failed = true;
  }
  redirect(await destinationFor(token, failed));
}

async function destinationFor(paypalOrderId: string, failed: boolean): Promise<string> {
  if (!/^[A-Z0-9]{10,32}$/.test(paypalOrderId)) return "/?checkout=failed";
  const d = await db();
  const [row] = await d
    .select({ orderId: schema.orders.id, slug: schema.stores.slug, requestId: schema.agreements.requestId })
    .from(schema.orders)
    .innerJoin(schema.stores, eq(schema.stores.id, schema.orders.storeId))
    .leftJoin(schema.agreements, eq(schema.agreements.id, schema.orders.agreementId))
    .where(eq(schema.orders.paypalOrderId, paypalOrderId));
  if (!row) return "/?checkout=failed";
  if (row.requestId) return `/s/${row.slug}/custom/${row.requestId}${failed ? "?checkout=failed" : ""}`;
  return failed ? "/?checkout=failed" : `/s/${row.slug}/order/${row.orderId}`;
}
