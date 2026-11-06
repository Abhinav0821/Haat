import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { env } from "@/lib/env";
import { paypal, PayPalApiError } from "@/lib/paypal/client";
import { randomUUID } from "node:crypto";
import { CAPTURED_STATUSES } from "@/lib/paypal/order-status";
import { AgreementError, beginAgreementCapture, endAgreementCapture } from "@/lib/custom/agreement";
import { finalizePayment, type PayPalOrderSnapshot } from "@/lib/paypal/finalize";
import { beginCollectiveCapture, endCollectiveCapture } from "@/lib/collective/checkout";
import { CollectiveError } from "@/lib/collective/service";
import { availableQuantity, ensureReservedForCapture, release, reserve, SoldOutError } from "@/lib/inventory";
import { readEconomics } from "@/lib/economics";

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

  const goodsCents = product.priceCents * quantity;
  const shippingCents = readEconomics(store.policy)?.shippingChargeUsdCents ?? 0;
  const totalCents = goodsCents + shippingCents;
  const appUrl = env().APP_URL;

  // Hold the piece first (row-locked), so two buyers or agents can't both take it.
  const orderId = randomUUID();
  try {
    await reserve(product.id, quantity, orderId);
  } catch (e) {
    if (e instanceof SoldOutError) {
      const stock = await availableQuantity(product.id);
      throw new CheckoutError(
        stock.sold >= stock.total
          ? "This piece has sold."
          : "Another buyer is paying for this piece right now. If they don't finish within 20 minutes, it becomes available again.",
        409,
      );
    }
    throw e;
  }

  let order: { id: string; status: string; links?: { rel: string; href: string }[] };
  try {
    order = await paypal<{ id: string; status: string; links?: { rel: string; href: string }[] }>("/v2/checkout/orders", {
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
            breakdown: {
              item_total: { currency_code: product.currency, value: usd(goodsCents) },
              shipping: { currency_code: product.currency, value: usd(shippingCents) },
            },
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
  } catch (e) {
    await release(orderId); // PayPal didn't create the order — free the piece
    throw e;
  }

  const [saved] = await d
    .insert(schema.orders)
    .values({
      id: orderId,
      storeId: store.id,
      paypalOrderId: order.id,
      status: "CREATED",
      amountCents: totalCents,
      shippingCents,
      currency: product.currency,
      items: [{ productId: product.id, qty: quantity, priceCents: product.priceCents }],
      channel,
    })
    .returning();

  const approveUrl = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href ?? null;
  return { paypalOrderId: order.id, orderId: saved.id, storeSlug: store.slug, amountCents: totalCents, approveUrl, product };
}

type CaptureResponse = PayPalOrderSnapshot;

export async function captureCheckoutOrder(paypalOrderId: string, deps: { paypalCall?: typeof paypal; now?: Date } = {}) {
  const call = deps.paypalCall ?? paypal;
  const now = deps.now ?? new Date();
  if (!/^[A-Z0-9]{10,32}$/.test(paypalOrderId)) throw new CheckoutError("invalid order id");
  const d = await db();
  const [order] = await d.select().from(schema.orders).where(eq(schema.orders.paypalOrderId, paypalOrderId));
  if (!order) throw new CheckoutError("unknown order", 404);
  if (CAPTURED_STATUSES.has(order.status)) {
    return { orderId: order.id, status: order.status }; // already captured (e.g. webhook got there first)
  }

  // Every capture path (browser, return URL, webhook) re-checks the stock hold and,
  // for custom orders and collective plans, atomically locks the exact terms version as
  // "paying" so nothing can revise or cancel it while PayPal is capturing.
  try {
    await ensureReservedForCapture(order.id, now);
    await beginAgreementCapture(order, now);
    await beginCollectiveCapture(order, now);
  } catch (e) {
    if (e instanceof SoldOutError || e instanceof AgreementError || e instanceof CollectiveError) throw new CheckoutError(e.message, 409);
    throw e;
  }

  let captured: CaptureResponse;
  try {
    captured = await call<CaptureResponse>(`/v2/checkout/orders/${paypalOrderId}/capture`, {
      method: "POST",
      requestId: `capture-${order.id}`,
      body: {},
    });
  } catch (e) {
    if (e instanceof PayPalApiError) {
      const issue = JSON.stringify(e.body);
      if (issue.includes("ORDER_ALREADY_CAPTURED")) {
        // Captured earlier (a lost response, or another path got there first): record it from PayPal's own data.
        const pp = await call<PayPalOrderSnapshot>(`/v2/checkout/orders/${paypalOrderId}`);
        const done = await finalizePayment(order.id, pp, now);
        return { orderId: order.id, status: done.status };
      }
      // Definite refusals: no money moved, so the terms are no longer "paying".
      if (issue.includes("INSTRUMENT_DECLINED")) {
        await endAgreementCapture(order);
        await endCollectiveCapture(order, now);
        throw new CheckoutError("Your payment method was declined. Please choose another in PayPal.", 422);
      }
      if (issue.includes("ORDER_NOT_APPROVED")) {
        await endAgreementCapture(order);
        await endCollectiveCapture(order, now);
        throw new CheckoutError("Payment not approved yet.", 409);
      }
    }
    // Unknown outcome (network, 5xx): stay "paying" until a retry, the webhook,
    // or reconciliation with PayPal settles it.
    throw e;
  }

  // Record the outcome from the CAPTURE record (pending ≠ paid; no capture record ≠ paid or failed).
  const done = await finalizePayment(order.id, captured, now);
  return { orderId: order.id, status: done.status };
}

export { feesFrom } from "@/lib/paypal/finalize";
