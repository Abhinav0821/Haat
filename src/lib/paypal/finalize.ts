import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { shouldAdvance } from "@/lib/paypal/order-status";

/**
 * ONE place that records the outcome of a PayPal capture — used by the browser
 * capture, the "already captured" recovery, webhooks and reconciliation alike.
 *
 * Completion is decided from the CAPTURE record, never from the order's
 * top-level status: PayPal can report an order COMPLETED while its capture is
 * still PENDING, and fulfilment must wait for the capture. No capture record →
 * "UNKNOWN": nothing is marked paid or failed.
 *
 * Idempotent: running it again with the same PayPal data leaves the same state.
 */

export type PayPalCapture = {
  id?: string;
  status?: string;
  create_time?: string;
  seller_receivable_breakdown?: { paypal_fee?: { value: string }; net_amount?: { value: string } };
};

export type PayPalOrderSnapshot = {
  id?: string;
  status?: string;
  payer?: { email_address?: string; name?: { given_name?: string; surname?: string } };
  purchase_units?: {
    shipping?: {
      name?: { full_name?: string };
      address?: { address_line_1?: string; address_line_2?: string; admin_area_2?: string; admin_area_1?: string; postal_code?: string; country_code?: string };
    };
    payments?: { captures?: PayPalCapture[] };
  }[];
};

export type CaptureOutcome = "COMPLETED" | "PENDING" | "DENIED" | "UNKNOWN";

export function captureOutcome(pp: PayPalOrderSnapshot): { outcome: CaptureOutcome; capture: PayPalCapture | null } {
  const capture = pp.purchase_units?.[0]?.payments?.captures?.[0] ?? null;
  switch (capture?.status) {
    case "COMPLETED":
      return { outcome: "COMPLETED", capture };
    case "PENDING":
      return { outcome: "PENDING", capture };
    case "DECLINED":
    case "DENIED":
    case "FAILED":
      return { outcome: "DENIED", capture };
    default:
      // Missing, refunded, reversed or unrecognised: not a basis for marking paid or failed.
      return { outcome: "UNKNOWN", capture };
  }
}

/** A capture-only payload (PAYMENT.CAPTURE.* webhooks) in the order-snapshot shape. */
export const snapshotFromCapture = (capture: PayPalCapture): PayPalOrderSnapshot => ({ purchase_units: [{ payments: { captures: [capture] } }] });

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

export async function finalizePayment(orderId: string, pp: PayPalOrderSnapshot, now = new Date()): Promise<{ outcome: CaptureOutcome; status: string }> {
  const d = await db();
  const [order] = await d.select().from(schema.orders).where(eq(schema.orders.id, orderId));
  if (!order) throw new Error(`order ${orderId} not found`);
  const { outcome, capture } = captureOutcome(pp);
  if (outcome === "UNKNOWN") return { outcome, status: order.status };

  const unit = pp.purchase_units?.[0];
  const a = unit?.shipping?.address;
  const buyerName = [pp.payer?.name?.given_name, pp.payer?.name?.surname].filter(Boolean).join(" ");
  const status = outcome; // COMPLETED | PENDING | DENIED are also order statuses
  await d
    .update(schema.orders)
    .set({
      ...(shouldAdvance(order.status, status) ? { status } : {}),
      paypalCaptureId: capture?.id ?? order.paypalCaptureId,
      // Only fill what this payload carries; never erase details recorded earlier.
      ...(pp.payer?.email_address ? { buyerEmail: pp.payer.email_address } : {}),
      ...(buyerName ? { buyerName } : {}),
      ...(a
        ? {
            shippingAddress: {
              name: unit?.shipping?.name?.full_name,
              lines: [a.address_line_1, a.address_line_2].filter((l): l is string => !!l),
              city: a.admin_area_2,
              state: a.admin_area_1,
              postalCode: a.postal_code,
              countryCode: a.country_code,
            },
          }
        : {}),
      ...(outcome === "COMPLETED" && !order.capturedAt ? { capturedAt: capture?.create_time ? new Date(capture.create_time) : now } : {}),
      ...feesFrom(capture?.seller_receivable_breakdown),
      updatedAt: now,
    })
    .where(eq(schema.orders.id, order.id));

  const { consume, release } = await import("@/lib/inventory");
  const { markAgreementPaid, endAgreementCapture } = await import("@/lib/custom/agreement");
  if (outcome === "COMPLETED") {
    await consume(order.id);
    await markAgreementPaid(order);
  } else if (outcome === "DENIED") {
    await release(order.id);
    await endAgreementCapture(order);
  } // PENDING: wait — the agreement stays "paying" and stock stays held until PayPal reports the outcome.
  const [fresh] = await d.select({ status: schema.orders.status }).from(schema.orders).where(eq(schema.orders.id, order.id));
  return { outcome, status: fresh?.status ?? status };
}
