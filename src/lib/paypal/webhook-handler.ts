import { eq, sql } from "drizzle-orm";
import { finalizePayment, snapshotFromCapture, type PayPalCapture, type PayPalOrderSnapshot } from "@/lib/paypal/finalize";
import { db, schema, withTx, type DB } from "@/db";
import { paypal } from "@/lib/paypal/client";
import { shouldAdvance } from "@/lib/paypal/order-status";

/**
 * Applies verified PayPal webhook events to our database.
 *
 *  - Idempotent: events are keyed by PayPal's event id; a redelivered event that
 *    was already processed is acknowledged and skipped.
 *  - Order-safe: PayPal does not guarantee delivery order, so order status only
 *    moves forward (an APPROVED arriving after COMPLETED is ignored).
 */

export type PayPalWebhookEvent = {
  id: string;
  event_type: string;
  resource_type?: string;
  create_time?: string;
  resource: Record<string, unknown>;
};

export type HandleResult =
  | { status: "duplicate" }
  | { status: "applied"; orderId: string; orderStatus: string }
  | { status: "recorded"; note: string };

export { shouldAdvance } from "@/lib/paypal/order-status";

type Capture = { id: string; status: string; supplementary_data?: { related_ids?: { order_id?: string } } };
export type CaptureLoader = (captureId: string) => Promise<Capture>;

const loadCapture: CaptureLoader = (id) => paypal<Capture>(`/v2/payments/captures/${encodeURIComponent(id)}`);

/** PayPal's authoritative order record (injected in tests). */
export type OrderLoader = (paypalOrderId: string) => Promise<PayPalOrderSnapshot>;
const loadOrder: OrderLoader = (id) => paypal<PayPalOrderSnapshot>(`/v2/checkout/orders/${encodeURIComponent(id)}`);

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** Work out which PayPal order an event refers to and the status it implies. */
async function interpret(
  event: PayPalWebhookEvent,
  getCapture: CaptureLoader,
): Promise<{ paypalOrderId: string; status: string; captureId?: string; snapshot?: PayPalOrderSnapshot } | null> {
  const r = event.resource;
  const relatedOrder = (res: Record<string, unknown>) =>
    str((res.supplementary_data as Capture["supplementary_data"])?.related_ids?.order_id);

  switch (event.event_type) {
    case "CHECKOUT.ORDER.APPROVED":
      return str(r.id) ? { paypalOrderId: str(r.id)!, status: "APPROVED" } : null;
    case "CHECKOUT.ORDER.COMPLETED":
      // The resource is the order: its capture record decides whether it's paid.
      return str(r.id) ? { paypalOrderId: str(r.id)!, status: "COMPLETED", snapshot: r as PayPalOrderSnapshot } : null;
    case "PAYMENT.CAPTURE.COMPLETED":
    case "PAYMENT.CAPTURE.PENDING":
    case "PAYMENT.CAPTURE.DENIED":
    case "PAYMENT.CAPTURE.REVERSED": {
      const orderId = relatedOrder(r);
      const status = event.event_type.split(".").pop()!;
      const snapshot = status === "REVERSED" ? undefined : snapshotFromCapture(r as PayPalCapture);
      return orderId ? { paypalOrderId: orderId, status, captureId: str(r.id), snapshot } : null;
    }
    case "PAYMENT.CAPTURE.REFUNDED": {
      // Resource is the *refund*; its "up" link points at the capture, whose
      // status tells us whether the order is now fully or partially refunded.
      const links = (r.links as { rel: string; href: string }[] | undefined) ?? [];
      const captureId = links.find((l) => l.rel === "up")?.href.split("/").pop();
      if (!captureId) return null;
      const capture = await getCapture(captureId);
      const orderId = relatedOrder(capture as unknown as Record<string, unknown>);
      const status = capture.status === "REFUNDED" ? "REFUNDED" : "PARTIALLY_REFUNDED";
      return orderId ? { paypalOrderId: orderId, status, captureId } : null;
    }
    default:
      return null; // disputes, invoices… recorded for the autopilot
  }
}

/** Captures an approved order (injected so tests don't call PayPal). */
export type Capturer = (paypalOrderId: string) => Promise<{ orderId: string; status: string }>;

const defaultCapturer: Capturer = async (id) => (await import("@/lib/paypal/orders")).captureCheckoutOrder(id);

export async function handleWebhookEvent(
  event: PayPalWebhookEvent,
  deps: {
    database?: DB;
    getCapture?: CaptureLoader;
    getOrder?: OrderLoader;
    capture?: Capturer;
    /** Test-only pause after the initial order read, before a non-capture status change. */
    afterStatusRead?: () => Promise<void>;
  } = {},
): Promise<HandleResult> {
  const d = deps.database ?? (await db());
  const { webhookEvents, orders } = schema;

  const inserted = await d
    .insert(webhookEvents)
    .values({ id: event.id, type: event.event_type, payload: event })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });

  if (inserted.length === 0) {
    const [existing] = await d.select().from(webhookEvents).where(eq(webhookEvents.id, event.id));
    if (existing?.processedAt) return { status: "duplicate" };
    // Previously received but processing failed — fall through and retry.
  }

  const target = await interpret(event, deps.getCapture ?? loadCapture);
  let result: HandleResult;

  if (!target) {
    result = { status: "recorded", note: `no order state change for ${event.event_type}` };
  } else {
    const [found] = await d.select().from(orders).where(eq(orders.paypalOrderId, target.paypalOrderId));
    // Capture outcomes go through the same finalisation as every other path (order
    // record, capture time, fees, stock, agreement) — idempotent, and it also recovers
    // a capture whose own response was lost.
    let finalized = found && target.snapshot ? await finalizePayment(found.id, target.snapshot) : null;
    if (found && finalized?.outcome === "UNKNOWN") {
      // The event doesn't say how the capture ended: ask PayPal for its own record.
      finalized = await finalizePayment(found.id, await (deps.getOrder ?? loadOrder)(found.paypalOrderId));
      if (finalized.outcome === "UNKNOWN") {
        // Still unresolved: change nothing and leave the event unprocessed (non-2xx → PayPal redelivers).
        throw new Error(`capture outcome for ${found.paypalOrderId} not yet known (${event.event_type}); will retry`);
      }
    }
    const [order] = found ? await d.select().from(orders).where(eq(orders.id, found.id)) : [];
    if (order && !finalized) await deps.afterStatusRead?.();

    if (finalized) {
      // Capture-bearing events: the order status comes ONLY from finalisation (the capture record).
      result = { status: "applied", orderId: order!.id, orderStatus: finalized.status };
    } else if (!order) {
      result = { status: "recorded", note: `order ${target.paypalOrderId} not in our database` };
    } else {
      // Non-capture events share the finaliser's order lock. The earlier read
      // can be stale if a browser capture or another webhook completed meanwhile.
      result = await withTx<HandleResult>(async (tx) => {
        await tx.execute(sql`select id from orders where id = ${order.id} for update`);
        const [current] = await tx.select().from(orders).where(eq(orders.id, order.id));
        if (!current) return { status: "recorded", note: `order ${target.paypalOrderId} not in our database` };
        if (!shouldAdvance(current.status, target.status)) {
          return { status: "recorded", note: `kept ${current.status} (event implied ${target.status})` };
        }
        await tx
          .update(orders)
          .set({
            status: target.status,
            // An approval has no capture ID; never copy a stale null over one.
            ...(target.captureId ? { paypalCaptureId: target.captureId } : {}),
            updatedAt: new Date(),
          })
          .where(eq(orders.id, current.id));
        return { status: "applied", orderId: current.id, orderStatus: target.status };
      }, d);
    }

    // Unfinished payment work is separate from status bookkeeping: an order the
    // buyer approved on PayPal (agent checkout or custom-order agreement) may still
    // need capturing — including on a redelivery after a transient failure, when
    // the order already reads APPROVED.
    if (order && target.status === "APPROVED" && (order.channel === "mcp" || order.agreementId || order.collectivePlanId)) {
      const [fresh] = await d.select({ status: orders.status }).from(orders).where(eq(orders.id, order.id));
      if (fresh?.status === "APPROVED" || fresh?.status === "CREATED") {
        try {
          const captured = await (deps.capture ?? defaultCapturer)(order.paypalOrderId);
          result = { status: "applied", orderId: order.id, orderStatus: captured.status };
        } catch (e) {
          // A refusal (sold out, terms changed) is a final answer: record it. Nothing was charged.
          // Anything else is transient: rethrow so the event stays unprocessed and PayPal redelivers it.
          if ((e as { status?: number }).status !== 409) throw e;
          result = { status: "recorded", note: `capture refused: ${(e as Error).message}` };
        }
      }
    }
  }

  await d.update(webhookEvents).set({ processedAt: new Date() }).where(eq(webhookEvents.id, event.id));
  return result;
}
