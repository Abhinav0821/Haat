import { and, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { env } from "@/lib/env";
import { paypal } from "@/lib/paypal/client";
import { feesFrom } from "@/lib/paypal/orders";
import { MAKER_PROFILES } from "@/lib/store";

/**
 * Daily brief — what happened in the shop, said in Hindi.
 * Numbers come from our records and PayPal's own fee breakdown; the sentences
 * are fixed templates, so the brief is exact and works even if the AI is down.
 */

export type BriefNumbers = {
  ownerName: string;
  paidOrders: number;
  grossCents: number;
  feeCents: number;
  netCents: number;
  refundedCents: number;
  toShip: number;
  pendingApprovals: number;
  unanswered: number;
  scamWarnings: number;
  inrPerUsd: number;
};

const dollars = (c: number) => (c / 100).toFixed(2);
const rupees = (c: number, rate: number) => Math.round((c / 100) * rate).toLocaleString("en-IN");

/** Pure: numbers → Hindi + English sentences. */
export function composeBrief(n: BriefNumbers) {
  const hi: string[] = [`नमस्ते ${n.ownerName} जी।`];
  const en: string[] = [`Hello ${n.ownerName}.`];

  if (n.paidOrders > 0) {
    hi.push(
      `पिछले 24 घंटों में ${n.paidOrders} ऑर्डर आए। कुल ${dollars(n.grossCents)} डॉलर में से PayPal की फ़ीस ${dollars(n.feeCents)} डॉलर कटकर आपको ${dollars(n.netCents)} डॉलर मिले, यानी लगभग ${rupees(n.netCents, n.inrPerUsd)} रुपये।`,
    );
    en.push(
      `In the last 24 hours you had ${n.paidOrders} order${n.paidOrders > 1 ? "s" : ""}: $${dollars(n.grossCents)} paid, $${dollars(n.feeCents)} PayPal fees, $${dollars(n.netCents)} to you (about ₹${rupees(n.netCents, n.inrPerUsd)}).`,
    );
  } else {
    hi.push("पिछले 24 घंटों में कोई नया ऑर्डर नहीं आया।");
    en.push("No new orders in the last 24 hours.");
  }
  if (n.refundedCents > 0) {
    hi.push(`${dollars(n.refundedCents)} डॉलर ख़रीदारों को वापस किए गए।`);
    en.push(`$${dollars(n.refundedCents)} was refunded to buyers.`);
  }
  if (n.scamWarnings > 0) {
    hi.push(`सावधान, ${n.scamWarnings} संदेशों में धोखे के संकेत मिले हैं। उन्हें ज़रूर सुनें।`);
    en.push(`Careful: ${n.scamWarnings} message${n.scamWarnings > 1 ? "s show" : " shows"} scam warning signs.`);
  }
  if (n.pendingApprovals > 0) {
    hi.push(`${n.pendingApprovals} रिफ़ंड पर आपकी मंज़ूरी चाहिए।`);
    en.push(`${n.pendingApprovals} refund${n.pendingApprovals > 1 ? "s need" : " needs"} your approval.`);
  }
  if (n.toShip > 0) {
    hi.push(`${n.toShip} ऑर्डर भेजने बाकी हैं। भेजकर ट्रैकिंग नंबर ज़रूर जोड़ें, इससे पैसा जल्दी मिलता है।`);
    en.push(`${n.toShip} order${n.toShip > 1 ? "s" : ""} to ship — add tracking so PayPal can release funds sooner.`);
  }
  if (n.unanswered > 0) {
    hi.push(`${n.unanswered} ख़रीदारों के सवालों का जवाब देना है।`);
    en.push(`${n.unanswered} buyer message${n.unanswered > 1 ? "s" : ""} waiting for your reply.`);
  }
  if (n.scamWarnings + n.pendingApprovals + n.toShip + n.unanswered === 0) {
    hi.push("बाकी सब ठीक है। अच्छा दिन बिताइए!");
    en.push("Everything else is in order. Have a good day!");
  }
  return { hi: hi.join(" "), en: en.join(" ") };
}

/** Fill in PayPal fee/net for captured orders recorded before we stored them. */
async function backfillFees(orders: (typeof schema.orders.$inferSelect)[]) {
  const d = await db();
  for (const o of orders) {
    if (o.feeCents !== null || !o.paypalCaptureId) continue;
    try {
      const cap = await paypal<{ seller_receivable_breakdown?: { paypal_fee?: { value: string }; net_amount?: { value: string } } }>(
        `/v2/payments/captures/${encodeURIComponent(o.paypalCaptureId)}`,
      );
      const fees = feesFrom(cap.seller_receivable_breakdown);
      if (fees.feeCents !== undefined) {
        await d.update(schema.orders).set(fees).where(eq(schema.orders.id, o.id));
        Object.assign(o, fees);
      }
    } catch (e) {
      console.warn("[brief] fee backfill failed:", (e as Error).message);
    }
  }
}

export async function buildDailyBrief(storeId: string, now = new Date()) {
  const d = await db();
  const since = new Date(now.getTime() - 24 * 3600_000);
  const [store] = await d.select().from(schema.stores).where(eq(schema.stores.id, storeId));

  const paid = await d
    .select()
    .from(schema.orders)
    .where(and(eq(schema.orders.storeId, storeId), isNotNull(schema.orders.capturedAt), gte(schema.orders.capturedAt, since)))
    .orderBy(desc(schema.orders.capturedAt));
  await backfillFees(paid);

  const refunds = await d
    .select({ input: schema.agentActions.input })
    .from(schema.agentActions)
    .where(
      and(
        eq(schema.agentActions.storeId, storeId),
        eq(schema.agentActions.tool, "create_refund"),
        eq(schema.agentActions.status, "executed"),
        gte(schema.agentActions.decidedAt, since),
      ),
    );

  const toShip = await d
    .select({ id: schema.orders.id })
    .from(schema.orders)
    .where(and(eq(schema.orders.storeId, storeId), eq(schema.orders.status, "COMPLETED"), isNull(schema.orders.trackingNumber)));

  const proposals = await d
    .select({ id: schema.agentActions.id })
    .from(schema.agentActions)
    .where(and(eq(schema.agentActions.storeId, storeId), eq(schema.agentActions.status, "proposed")));

  const buyerMsgs = await d
    .select({ id: schema.messages.id, shield: schema.messages.shield, createdAt: schema.messages.createdAt })
    .from(schema.messages)
    .where(and(eq(schema.messages.storeId, storeId), eq(schema.messages.direction, "buyer_to_seller")));
  const repliedTo = new Set(
    (
      await d
        .select({ parentId: schema.messages.parentId })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.storeId, storeId),
            inArray(schema.messages.direction, ["seller_to_buyer"]),
            isNotNull(schema.messages.parentId),
          ),
        )
    ).map((r) => r.parentId),
  );

  const numbers: BriefNumbers = {
    ownerName: (store && MAKER_PROFILES[store.slug]?.ownerNameHi) || store?.ownerName || "",
    paidOrders: paid.length,
    grossCents: paid.reduce((s, o) => s + o.amountCents, 0),
    feeCents: paid.reduce((s, o) => s + (o.feeCents ?? 0), 0),
    netCents: paid.reduce((s, o) => s + (o.netCents ?? o.amountCents - (o.feeCents ?? 0)), 0),
    refundedCents: refunds.reduce((s, r) => s + ((r.input as { amountCents?: number }).amountCents ?? 0), 0),
    toShip: toShip.length,
    pendingApprovals: proposals.length,
    unanswered: buyerMsgs.filter((m) => !repliedTo.has(m.id)).length,
    scamWarnings: buyerMsgs.filter((m) => m.createdAt >= since && m.shield?.level === "danger").length,
    inrPerUsd: env().INR_PER_USD,
  };
  return { numbers, ...composeBrief(numbers), generatedAt: now.toISOString() };
}
