import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { env } from "@/lib/env";
import { paypal, PayPalApiError } from "@/lib/paypal/client";
import { CAPTURED_STATUSES, shouldAdvance } from "@/lib/paypal/order-status";

/**
 * Checkout (Orders v2). Deliberately deterministic — no LLM touches this path.
 *  - Prices come from our database, never from the browser or an agent.
 *  - shipping_preference GET_FROM_FILE: the buyer ships to their PayPal-confirmed
 *    address, which is what PayPal Seller Protection covers.
 *  - Capture is idempotent per order (PayPal-Request-Id), so double clicks,
 *    retries and the webhook racing the browser can't double-charge.
 */

const usd = (cents: number) => (cents / 100).toFixed(2);

export class CheckoutError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export type Channel = "storefront" | "mcp" | "chat";

export async function createCheckoutOrder({
  productId,
  quantity = 1,
  channel = "storefront",
}: {
  productId: string;
  quantity?: number;
  channel?: Channel;
}) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) throw new CheckoutError("quantity must be 1–10");

  const d = await db();
  const [row] = await d
    .select({ product: schema.products, store: schema.stores })
    .from(schema.products)
    .innerJoin(schema.stores, eq(schema.stores.id, schema.products.storeId))
    .where(and(eq(schema.products.id, productId), eq(schema.products.status, "live")));
  if (!row) throw new CheckoutError("product not available", 404);
  const { product, store } = row;

  const totalCents = product.priceCents * quantity;
  const appUrl = env().APP_URL;

  const order = await paypal<{ id: string; status: string; links?: { rel: string; href: string }[] }>("/v2/checkout/orders", {
    method: "POST",
    body: {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: product.id,
          description: product.title.slice(0, 127),
          soft_descriptor: "HAAT",
          amount: {
            currency_code: product.currency,
            value: usd(totalCents),
            breakdown: { item_total: { currency_code: product.currency, value: usd(totalCents) } },
          },
          items: [
            {
              name: product.title.slice(0, 127),
              quantity: String(quantity),
              unit_amount: { currency_code: product.currency, value: usd(product.priceCents) },
              category: "PHYSICAL_GOODS",
              sku: product.id.slice(0, 127),
            },
          ],
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: store.name.slice(0, 127),
            shipping_preference: "GET_FROM_FILE",
            user_action: "PAY_NOW",
            // PayPal appends ?token=<order id>&PayerID=… — used by redirect flows (AI-agent checkout links).
            return_url: `${appUrl}/api/checkout/return`,
            cancel_url: `${appUrl}/s/${store.slug}/p/${product.id}?paypal=cancel`,
          },
        },
      },
    },
  });

  const [saved] = await d
    .insert(schema.orders)
    .values({
      storeId: store.id,
      paypalOrderId: order.id,
      status: "CREATED",
      amountCents: totalCents,
      currency: product.currency,
      items: [{ productId: product.id, qty: quantity, priceCents: product.priceCents }],
      channel,
    })
    .returning();

  const approveUrl = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href ?? null;
  return { paypalOrderId: order.id, orderId: saved.id, storeSlug: store.slug, amountCents: totalCents, approveUrl, product };
}

type CaptureResponse = {
  id: string;
  status: string;
  payer?: { email_address?: string; name?: { given_name?: string; surname?: string } };
  purchase_units?: {
    shipping?: {
      name?: { full_name?: string };
      address?: {
        address_line_1?: string;
        address_line_2?: string;
        admin_area_2?: string;
        admin_area_1?: string;
        postal_code?: string;
        country_code?: string;
      };
    };
    payments?: {
      captures?: {
        id: string;
        status: string;
        seller_receivable_breakdown?: { paypal_fee?: { value: string }; net_amount?: { value: string } };
      }[];
    };
  }[];
};

export async function captureCheckoutOrder(paypalOrderId: string) {
  if (!/^[A-Z0-9]{10,32}$/.test(paypalOrderId)) throw new CheckoutError("invalid order id");
  const d = await db();
  const [order] = await d.select().from(schema.orders).where(eq(schema.orders.paypalOrderId, paypalOrderId));
  if (!order) throw new CheckoutError("unknown order", 404);
  if (CAPTURED_STATUSES.has(order.status)) {
    return { orderId: order.id, status: order.status }; // already captured (e.g. webhook got there first)
  }

  let captured: CaptureResponse;
  try {
    captured = await paypal<CaptureResponse>(`/v2/checkout/orders/${paypalOrderId}/capture`, {
      method: "POST",
      requestId: `capture-${order.id}`,
      body: {},
    });
  } catch (e) {
    if (e instanceof PayPalApiError) {
      const issue = JSON.stringify(e.body);
      if (issue.includes("ORDER_ALREADY_CAPTURED")) {
        const [fresh] = await d.select().from(schema.orders).where(eq(schema.orders.id, order.id));
        return { orderId: order.id, status: fresh?.status ?? "COMPLETED" };
      }
      if (issue.includes("INSTRUMENT_DECLINED")) {
        throw new CheckoutError("Your payment method was declined. Please choose another in PayPal.", 422);
      }
      if (issue.includes("ORDER_NOT_APPROVED")) throw new CheckoutError("Payment not approved yet.", 409);
    }
    throw e;
  }

  const unit = captured.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  const status = capture?.status === "COMPLETED" ? "COMPLETED" : capture?.status === "PENDING" ? "PENDING" : "DENIED";
  const a = unit?.shipping?.address;

  const [current] = await d.select().from(schema.orders).where(eq(schema.orders.id, order.id));
  await d
    .update(schema.orders)
    .set({
      ...(current && shouldAdvance(current.status, status) ? { status } : {}),
      paypalCaptureId: capture?.id ?? order.paypalCaptureId,
      buyerEmail: captured.payer?.email_address ?? null,
      buyerName: [captured.payer?.name?.given_name, captured.payer?.name?.surname].filter(Boolean).join(" ") || null,
      shippingAddress: a
        ? {
            name: unit?.shipping?.name?.full_name,
            lines: [a.address_line_1, a.address_line_2].filter((l): l is string => !!l),
            city: a.admin_area_2,
            state: a.admin_area_1,
            postalCode: a.postal_code,
            countryCode: a.country_code,
          }
        : null,
      capturedAt: status === "COMPLETED" ? new Date() : null,
      ...feesFrom(capture?.seller_receivable_breakdown),
      updatedAt: new Date(),
    })
    .where(eq(schema.orders.id, order.id));

  return { orderId: order.id, status };
}

/** PayPal's own fee/net for a capture, in cents (undefined fields are left untouched). */
export function feesFrom(b?: { paypal_fee?: { value: string }; net_amount?: { value: string } }) {
  const cents = (v?: string) => (v === undefined ? undefined : Math.round(parseFloat(v) * 100));
  const out: { feeCents?: number; netCents?: number } = {};
  const fee = cents(b?.paypal_fee?.value);
  const net = cents(b?.net_amount?.value);
  if (fee !== undefined) out.feeCents = fee;
  if (net !== undefined) out.netCents = net;
  return out;
}
