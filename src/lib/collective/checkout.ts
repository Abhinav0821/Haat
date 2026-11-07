import { and, eq, inArray, ne } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, schema, withTx, type DB, type Tx } from "@/db";
import { logEvent } from "@/lib/events";
import { paypal } from "@/lib/paypal/client";
import type { PayPalOrderSnapshot } from "@/lib/paypal/finalize";
import { dayDate, dayIndex, type CollectiveFacts, type Plan } from "@/lib/planner/model";
import type { DatedReservation } from "./facts";
import { CollectiveError, currentPlan, LIVE, lockOrderTree, partsAllAccepted, planStart } from "./service";
import type { PartTerms, PlanTerms } from "./terms";

/**
 * Collective checkout. The collective is the seller (merchant of record): the buyer pays
 * the collective through PayPal for one exact plan version, and the collective owes each
 * maker her accepted part's pay.
 *
 *  - The PayPal order is created only for the current, buyer-approved, still-held plan
 *    whose every part is accepted on its own link on its exact hash. Its amount comes from
 *    the plan's frozen terms; the order row records the plan id and terms hash.
 *  - Every capture path (browser return, webhook, retry) first locks that exact plan as
 *    "paying" under the order's locks (collective → order → plans → parts), re-checking
 *    all of the above. While paying, nothing can re-plan it, change a maker's answer,
 *    change her facts or change the requirements.
 *  - A completed capture marks the plan paid and creates each maker's share (owed) exactly
 *    once. A definite refusal returns it to approved. Anything unknown stays "paying" and
 *    is reconciled with PayPal's own record once stale.
 *
 * Deterministic: no model touches this path.
 */

export const PAYING_STALE_MS = 10 * 60_000;
// The HTTP deadline is shorter than the lease; recovery starts much later still.
export const CAPTURE_HTTP_TIMEOUT_MS = 45_000;
export const CAPTURE_LEASE_MS = 60_000;

type PlanRow = typeof schema.collectivePlans.$inferSelect;
export type CollectivePaymentRef = { id: string; collectivePlanId: string | null; termsHash: string | null; amountCents: number };
export type CollectiveCaptureFence = { attemptId: string | null; payingSince: Date | null };
type CaptureStart = { kind: "started"; fence: CollectiveCaptureFence; leaseUntil: Date } | { kind: "none" | "already_paid" | "in_progress" };

const fenceOf = (p: PlanRow): CollectiveCaptureFence => ({ attemptId: p.captureAttemptId, payingSince: p.payingSince });
const matchesAttempt = (p: PlanRow, fence: CollectiveCaptureFence) => p.captureAttemptId === fence.attemptId && p.payingSince?.getTime() === fence.payingSince?.getTime();

/** Test-only pause points. */
export type CheckoutHooks = { afterRead?: () => Promise<void> };

const startOf = (plan: PlanRow) => (plan.facts as unknown as CollectiveFacts).startDate;

/** The single rule for "may this plan be paid now" (`current` is the order's live plan, after any lapse). */
export async function payableProblem(q: DB | Tx, plan: PlanRow | undefined, current: PlanRow | undefined, now: Date): Promise<string | null> {
  if (!plan) return "These terms weren't found.";
  if (plan.status === "paid") return "This order is already paid.";
  if (plan.status === "paying") return "A payment for these terms is already being processed.";
  if (!current || current.id !== plan.id || plan.status === "superseded" || plan.status === "cancelled") return "These terms were replaced by a newer version.";
  if (plan.status === "awaiting_makers") return "Not every maker has confirmed her part yet.";
  if (plan.status === "maker_declined" || plan.status === "needs_replan") return "These terms are being revised.";
  if (plan.status === "ready") return "Please approve the terms first. If you approved earlier, the reservation lapsed: approve again to re-check it.";
  if (plan.status !== "approved") return `These terms are ${plan.status}.`;
  if (plan.buyerApprovedHash !== plan.termsHash) return "Your approval doesn't match these terms.";
  if (!plan.holdUntil || plan.holdUntil <= now) return "The reservation lapsed. Please approve the terms again.";
  if (!plan.reserved) return "No capacity is reserved for these terms. Please approve them again.";
  const terms = plan.terms as unknown as PlanTerms;
  if (!terms.buyer.payment) return "These terms were made before payment was available. The coordinator will send a new version.";
  if (!(await partsAllAccepted(q, terms.parts))) return "Not every maker's acceptance stands for these exact terms.";
  const p = plan.plan as unknown as Plan;
  const first = dayIndex(startOf(plan), planStart(now));
  if (p.production.some((x) => x.day < first) || p.finishing.some((x) => x.day < first)) return "The first work day has already started, so these terms can't be paid. The coordinator will send revised terms.";
  return null;
}

const usd = (c: number) => (c / 100).toFixed(2);

/** A PayPal order for exactly the approved plan. Same plan and hash → the same PayPal order on retry. */
export async function createCollectiveCheckout(orderId: string, planId: string, hash: string, ctx: { appUrl: string }, now = new Date()) {
  const d = await db();
  const plan = await reconcileCollectiveIfStale(await currentPlan(d, orderId, now), { now });
  if (!plan || plan.id !== planId) throw new CollectiveError("These terms were replaced by a newer version. Please review the latest terms.");
  const problem = await payableProblem(d, plan, plan, now);
  if (problem) throw new CollectiveError(problem);
  if (hash !== plan.termsHash) throw new CollectiveError("The terms changed since you approved them. Please review again.");
  const [c] = await d.select().from(schema.collectives).where(eq(schema.collectives.id, plan.collectiveId));
  const t = (plan.terms as unknown as PlanTerms).buyer;
  const name = `${t.quantity} × ${t.product.en}`;

  const pp = await paypal<{ id: string; links?: { rel: string; href: string }[] }>("/v2/checkout/orders", {
    method: "POST",
    requestId: `collective-${plan.id}-${plan.termsHash.slice(0, 16)}`,
    body: {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: plan.id,
          custom_id: plan.id,
          description: `${c.name}: ${name} (terms v${plan.version})`.slice(0, 127),
          soft_descriptor: "HAAT",
          amount: { currency_code: "USD", value: usd(t.totalUsdCents), breakdown: { item_total: { currency_code: "USD", value: usd(t.totalUsdCents) } } },
          // One line for the whole agreed order: the agreed total includes shipping and isn't a per-piece price.
          items: [{ name: `Collective order: ${name}`.slice(0, 127), quantity: "1", unit_amount: { currency_code: "USD", value: usd(t.totalUsdCents) }, category: "PHYSICAL_GOODS" }],
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: c.name.slice(0, 127),
            shipping_preference: "GET_FROM_FILE",
            user_action: "PAY_NOW",
            return_url: `${ctx.appUrl}/api/checkout/return`,
            cancel_url: `${ctx.appUrl}/c/orders/${orderId}?paypal=cancel`,
          },
        },
      },
    },
  });

  // Two clicks at once get the same PayPal order (same request id) and one row: the unique PayPal id decides.
  await d
    .insert(schema.orders)
    .values({ storeId: null, paypalOrderId: pp.id, status: "CREATED", amountCents: t.totalUsdCents, shippingCents: 0, currency: "USD", items: [], channel: "collective", collectivePlanId: plan.id, termsHash: plan.termsHash })
    .onConflictDoNothing();
  const [saved] = await d.select().from(schema.orders).where(eq(schema.orders.paypalOrderId, pp.id));
  if (saved.collectivePlanId !== plan.id || saved.termsHash !== plan.termsHash || saved.amountCents !== t.totalUsdCents) {
    throw new CollectiveError("PayPal returned an order that belongs to other terms. Nothing was charged.", 500);
  }
  const approveUrl = pp.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href ?? null;
  return { paypalOrderId: pp.id, orderId: saved.id, approveUrl, totalUsdCents: t.totalUsdCents };
}

async function planRef(planId: string) {
  const [ref] = await (await db()).select({ orderId: schema.collectivePlans.orderId }).from(schema.collectivePlans).where(eq(schema.collectivePlans.id, planId));
  return ref;
}

/**
 * Called by EVERY capture path BEFORE PayPal is asked to capture. Locks the exact plan this
 * PayPal order was created for as "paying", after re-checking that it may be paid now.
 */
export async function beginCollectiveCapture(order: CollectivePaymentRef, clock: Date | (() => Date) = () => new Date(), hooks: CheckoutHooks = {}): Promise<CaptureStart> {
  if (!order.collectivePlanId) return { kind: "none" };
  const ref = await planRef(order.collectivePlanId);
  if (!ref) throw new CollectiveError("These terms weren't found. You have not been charged.");
  return withTx(async (tx) => {
    await lockOrderTree(tx, ref.orderId);
    const now = typeof clock === "function" ? clock() : clock;
    const current = await currentPlan(tx, ref.orderId, now);
    const [plan] = await tx.select().from(schema.collectivePlans).where(eq(schema.collectivePlans.id, order.collectivePlanId!));
    await hooks.afterRead?.();
    if (!plan || plan.termsHash !== order.termsHash) throw new CollectiveError("These terms changed after checkout started. You have not been charged.");
    if (plan.status === "paid") {
      if (plan.paymentRef === order.id) return { kind: "already_paid" };
      throw new CollectiveError("These terms were already paid with another payment. You have not been charged.");
    }
    if (order.amountCents !== (plan.terms as unknown as PlanTerms).buyer.totalUsdCents) throw new CollectiveError("This payment's amount doesn't match the terms. You have not been charged.");
    if (plan.status === "paying") {
      if (plan.paymentRef !== order.id) throw new CollectiveError("Another payment for these terms is in progress. You have not been charged.");
      if (plan.captureLeaseUntil && plan.captureLeaseUntil > now) return { kind: "in_progress" };
      // Unknown outcome: retry the SAME idempotent PayPal operation, with a new
      // local attempt id so an earlier response/lookup cannot unlock this attempt.
    } else {
      const problem = await payableProblem(tx, plan, current, now);
      if (problem) throw new CollectiveError(`${problem} You have not been charged.`);
    }
    const fence: CollectiveCaptureFence = { attemptId: randomUUID(), payingSince: now };
    const leaseUntil = new Date(now.getTime() + CAPTURE_LEASE_MS);
    await tx.update(schema.collectivePlans).set({ status: "paying", payingSince: now, paymentRef: order.id, captureAttemptId: fence.attemptId, captureLeaseUntil: leaseUntil }).where(eq(schema.collectivePlans.id, plan.id));
    await tx.update(schema.collectiveOrders).set({ status: "paying", updatedAt: now }).where(eq(schema.collectiveOrders.id, ref.orderId));
    return { kind: "started", fence, leaseUntil };
  });
}

/** Release only THIS HTTP call's lease; an uncertain payment stays locked as paying. */
export async function finishCollectiveCaptureAttempt(order: CollectivePaymentRef, fence: CollectiveCaptureFence) {
  if (!order.collectivePlanId) return;
  const ref = await planRef(order.collectivePlanId);
  if (!ref) return;
  await withTx(async (tx) => {
    await lockOrderTree(tx, ref.orderId);
    const [plan] = await tx.select().from(schema.collectivePlans).where(eq(schema.collectivePlans.id, order.collectivePlanId!));
    if (!plan || plan.status !== "paying" || plan.paymentRef !== order.id || !matchesAttempt(plan, fence)) return;
    await tx.update(schema.collectivePlans).set({ captureLeaseUntil: null }).where(eq(schema.collectivePlans.id, plan.id));
  });
}

/** A negative result may unlock only the exact, no-longer-in-flight attempt it checked. */
export async function endCollectiveCapture(order: CollectivePaymentRef, now = new Date(), fence?: CollectiveCaptureFence) {
  if (!order.collectivePlanId || !fence) return;
  const ref = await planRef(order.collectivePlanId);
  if (!ref) return;
  await withTx(async (tx) => {
    await lockOrderTree(tx, ref.orderId);
    const [plan] = await tx.select().from(schema.collectivePlans).where(eq(schema.collectivePlans.id, order.collectivePlanId!));
    if (!plan || plan.status !== "paying" || plan.paymentRef !== order.id || !matchesAttempt(plan, fence)) return;
    if (plan.captureLeaseUntil && plan.captureLeaseUntil > now) return;
    await tx.update(schema.collectivePlans).set({ status: "approved", payingSince: null, paymentRef: null, captureAttemptId: null, captureLeaseUntil: null }).where(eq(schema.collectivePlans.id, plan.id));
    await tx.update(schema.collectiveOrders).set({ status: "approved", updatedAt: now }).where(eq(schema.collectiveOrders.id, ref.orderId));
  });
}

function reservationOf(plan: PlanRow): DatedReservation {
  const p = plan.plan as unknown as Plan;
  const start = startOf(plan);
  return {
    planId: plan.id,
    production: p.production.map((x) => ({ memberId: x.makerId, date: dayDate(start, x.day), pieces: x.pieces })),
    finishing: p.finishing.map((x) => ({ date: dayDate(start, x.day), pieces: x.pieces })),
  };
}

/**
 * Money was captured: record it against the EXACT plan the PayPal order was created for,
 * and create each maker's share once. With "paying" blocking every change this is the
 * current version; if not (it shouldn't happen), the paid terms still win, newer unpaid
 * versions are cancelled, and the plan carries a note for the coordinator to review.
 */
export async function markCollectivePaid(order: CollectivePaymentRef, now = new Date()) {
  if (!order.collectivePlanId) return;
  const ref = await planRef(order.collectivePlanId);
  if (!ref) return;
  const events: [string, Record<string, unknown>][] = [];
  await withTx(async (tx) => {
    const collectiveId = await lockOrderTree(tx, ref.orderId);
    const [plan] = await tx.select().from(schema.collectivePlans).where(eq(schema.collectivePlans.id, order.collectivePlanId!));
    if (!plan || plan.termsHash !== order.termsHash) {
      events.push(["collective_capture_unmatched", { orderId: order.id, planId: order.collectivePlanId }]);
      return;
    }
    if (plan.status === "paid" && plan.paymentRef !== order.id) {
      // A second capture for terms already paid: the buyer was charged twice. Never absorbed silently.
      events.push(["collective_double_payment", { planId: plan.id, orderId: order.id, firstOrderId: plan.paymentRef }]);
      await tx.update(schema.collectivePlans).set({ statusNote: `A second payment (order ${order.id.slice(0, 8)}) was captured for these paid terms: refund it.` }).where(eq(schema.collectivePlans.id, plan.id));
      return;
    }
    const terms = plan.terms as unknown as PlanTerms;
    if (plan.status !== "paid") {
      const notes: string[] = [];
      if (plan.status !== "paying") notes.push(`Paid while the plan was ${plan.status.replace("_", " ")}: check capacity and makers' consent.`);
      if (!(await partsAllAccepted(tx, terms.parts))) notes.push("Not every maker's acceptance stands for these terms.");
      await tx
        .update(schema.collectivePlans)
        .set({ status: "paid", paymentRef: order.id, payingSince: null, captureAttemptId: null, captureLeaseUntil: null, reserved: (plan.reserved ?? reservationOf(plan)) as unknown as Record<string, unknown>, statusNote: notes.join(" ") || null })
        .where(eq(schema.collectivePlans.id, plan.id));
      const cancelled = await tx
        .update(schema.collectivePlans)
        .set({ status: "cancelled", statusNote: "Another version of these terms was paid." })
        .where(and(eq(schema.collectivePlans.orderId, ref.orderId), ne(schema.collectivePlans.id, plan.id), inArray(schema.collectivePlans.status, LIVE)))
        .returning({ id: schema.collectivePlans.id });
      await tx.update(schema.collectiveOrders).set({ status: "paid", updatedAt: now }).where(eq(schema.collectiveOrders.id, ref.orderId));
      if (notes.length || cancelled.length) events.push(["collective_paid_while_revised", { planId: plan.id, was: plan.status, cancelled: cancelled.length }]);
    }
    // Her share: exactly once per (plan, maker), from her accepted part and its hash.
    const parts = await tx.select().from(schema.memberParts).where(inArray(schema.memberParts.id, terms.parts.map((r) => r.partId)));
    for (const r of terms.parts) {
      const part = parts.find((x) => x.id === r.partId);
      if (!part) continue;
      await tx
        .insert(schema.makerShares)
        .values({ collectiveId, orderId: ref.orderId, planId: plan.id, memberId: r.memberId, partId: r.partId, partTermsHash: r.termsHash, owedPaise: Math.round((part.terms as unknown as PartTerms).payInr * 100) })
        .onConflictDoNothing();
    }
  });
  for (const [name, props] of events) await logEvent(name, props);
}

/** PayPal order states in which no capture can have happened. */
const NEVER_CAPTURED = new Set(["CREATED", "SAVED", "APPROVED", "PAYER_ACTION_REQUIRED", "VOIDED"]);

/**
 * A "paying" plan whose capture outcome never arrived is reconciled with PayPal's own
 * record once stale, through the same finaliser as every capture path. Anything
 * ambiguous stays "paying" rather than guess.
 */
export async function reconcileCollectiveIfStale<T extends PlanRow | undefined>(
  plan: T,
  deps: { now?: Date; lookup?: (paypalOrderId: string) => Promise<PayPalOrderSnapshot> } = {},
): Promise<T> {
  const now = deps.now ?? new Date();
  if (!plan || plan.status !== "paying" || !plan.payingSince || now.getTime() - plan.payingSince.getTime() < PAYING_STALE_MS || !plan.paymentRef) return plan;
  const d = await db();
  const [order] = await d.select().from(schema.orders).where(eq(schema.orders.id, plan.paymentRef));
  if (!order) return plan;
  const fence = fenceOf(plan);
  try {
    const pp = await (deps.lookup ?? ((id: string) => paypal<PayPalOrderSnapshot>(`/v2/checkout/orders/${encodeURIComponent(id)}`)))(order.paypalOrderId);
    const { finalizePayment, captureOutcome } = await import("@/lib/paypal/finalize");
    if (captureOutcome(pp).outcome !== "UNKNOWN") await finalizePayment(order.id, pp, now, { collectiveCaptureFence: fence });
    else if (!pp.purchase_units?.[0]?.payments?.captures?.length && NEVER_CAPTURED.has(pp.status ?? "")) await endCollectiveCapture(order, now, fence);
  } catch (e) {
    console.warn("[collective] reconcile failed:", (e as Error).message);
    return plan;
  }
  const [fresh] = await d.select().from(schema.collectivePlans).where(eq(schema.collectivePlans.id, plan.id));
  return (fresh ?? plan) as T;
}
