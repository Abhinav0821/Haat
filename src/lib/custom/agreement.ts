import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, or } from "drizzle-orm";
import { db, schema, withTx } from "@/db";
import { readEconomics, type Economics } from "@/lib/economics";
import { env } from "@/lib/env";
import { canonical } from "@/lib/passport/signing";
import { paypal } from "@/lib/paypal/client";
import type { CustomSpec, OptionVerdict } from "./quote";

/**
 * Custom-order agreements: one immutable set of terms that BOTH people approve.
 *
 *  - Terms are frozen and hashed (SHA-256 of canonical JSON).
 *  - An approval records the hash it approved; it only counts for that hash.
 *  - Any change creates a new version; the old one is superseded and its
 *    approvals no longer count.
 *  - A PayPal order can only be created for the current version with both
 *    approvals, and its capture re-checks that (see assertCapturable).
 */

export const HOLD_MS = 48 * 3600_000; // capacity held after approval while unpaid

export type Terms = {
  v: 1;
  shop: string;
  maker: string;
  item: string;
  quantity: number;
  unitPriceUsdCents: number;
  shippingUsdCents: number;
  totalUsdCents: number;
  colors: string[];
  materials: string[];
  completionBy: string;
  deliveryEstimate: string;
  handmadeVariation: string;
  refundTerms: string;
  note: string | null;
};

export class AgreementError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

export function hashTerms(t: Terms): string {
  return createHash("sha256").update(canonical(t)).digest("hex");
}

export function buildTerms(v: OptionVerdict, req: CustomSpec, shop: { name: string; ownerName: string }, e: Economics): Terms {
  return {
    v: 1,
    shop: shop.name,
    maker: shop.ownerName,
    item: req.item,
    quantity: v.option.quantity,
    unitPriceUsdCents: v.option.unitPriceUsdCents,
    shippingUsdCents: e.shippingChargeUsdCents,
    totalUsdCents: v.option.unitPriceUsdCents * v.option.quantity + e.shippingChargeUsdCents,
    colors: v.option.colors ?? req.colors,
    materials: v.option.materials ?? req.materials,
    completionBy: v.completion,
    deliveryEstimate: v.delivery,
    handmadeVariation: "Each piece is printed by hand: small differences in colour and pattern between pieces are part of handmade work.",
    refundTerms:
      "Made to order, so no returns for change of mind. Pieces that arrive damaged or not as agreed are refunded under the maker's refund policy.",
    note: v.option.note,
  };
}

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const longDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

export function termsLinesEn(t: Terms): [string, string][] {
  return [
    ["Item", `${t.quantity} × ${t.item}`],
    ["Colours / materials", [...t.colors, ...t.materials].join(", ") || "—"],
    ["Price", `${usd(t.unitPriceUsdCents)} each · ${usd(t.unitPriceUsdCents * t.quantity)} for ${t.quantity}`],
    ["Shipping", usd(t.shippingUsdCents)],
    ["Total", usd(t.totalUsdCents)],
    ["Made by", longDate(t.completionBy)],
    ["Estimated delivery", `${longDate(t.deliveryEstimate)} (estimate — courier times vary)`],
    ["Handmade variation", t.handmadeVariation],
    ["Refunds", t.refundTerms],
    ...(t.note ? ([["Note", t.note]] as [string, string][]) : []),
  ];
}

/** Read aloud to the maker (fixed template). */
export function termsHi(t: Terms, inrPerUsd: number, itemHi?: string, wordsHi?: { colors: string[]; materials: string[]; from: { colors: string[]; materials: string[] } }): string {
  const sameAs = (a: string[], b: string[]) => a.join("|") === b.join("|");
  const colors = wordsHi && sameAs(t.colors, wordsHi.from.colors) && wordsHi.colors.length === t.colors.length ? wordsHi.colors : t.colors;
  const materials = wordsHi && sameAs(t.materials, wordsHi.from.materials) && wordsHi.materials.length === t.materials.length ? wordsHi.materials : t.materials;
  const inr = Math.round((t.totalUsdCents / 100) * inrPerUsd).toLocaleString("en-IN");
  const day = (iso: string) => new Date(iso).toLocaleDateString("hi-IN", { day: "numeric", month: "long", timeZone: "UTC" });
  return `समझौता: ${t.quantity} पीस ${itemHi || t.item}, ${[...colors, ...materials].join(", ")}। हर पीस ${(t.unitPriceUsdCents / 100).toFixed(2)} डॉलर, शिपिंग ${(t.shippingUsdCents / 100).toFixed(2)} डॉलर, कुल ${(t.totalUsdCents / 100).toFixed(2)} डॉलर, यानी लगभग ${inr} रुपये। ${day(t.completionBy)} तक बनाना है, पहुँचने का अनुमान ${day(t.deliveryEstimate)}। मन बदलने पर वापसी नहीं; ख़राब पहुँचे तो आपकी रिफ़ंड नीति लागू होगी।`;
}

/** Pieces still to make: her stated backlog + approved (held) agreements + paid ones not yet finished. */
export async function effectiveBacklog(storeId: string, e: Economics, opts: { now?: Date; excludeRequestId?: string } = {}): Promise<number> {
  const d = await db();
  const now = opts.now ?? new Date();
  const rows = await d
    .select({ terms: schema.agreements.terms, requestId: schema.agreements.requestId, status: schema.agreements.status, piecesDone: schema.agreements.piecesDone })
    .from(schema.agreements)
    .where(
      and(
        eq(schema.agreements.storeId, storeId),
        or(eq(schema.agreements.status, "paid"), and(eq(schema.agreements.status, "approved"), gt(schema.agreements.holdUntil, now))),
      ),
    );
  const remaining = (r: (typeof rows)[number]) => Math.max(0, ((r.terms as Terms).quantity ?? 0) - (r.status === "paid" ? r.piecesDone : 0));
  return e.backlogPieces + rows.filter((r) => r.requestId !== opts.excludeRequestId).reduce((s, r) => s + remaining(r), 0);
}

export async function proposeAgreement(requestId: string, storeId: string, terms: Terms) {
  return withTx(async (tx) => {
    // Supersede the current (non-final) version, if any.
    const [current] = await tx
      .select()
      .from(schema.agreements)
      .where(and(eq(schema.agreements.requestId, requestId), inArray(schema.agreements.status, ["proposed", "approved"])))
      .orderBy(desc(schema.agreements.version));
    const [latest] = await tx
      .select({ version: schema.agreements.version })
      .from(schema.agreements)
      .where(eq(schema.agreements.requestId, requestId))
      .orderBy(desc(schema.agreements.version));
    const id = randomUUID();
    const [created] = await tx
      .insert(schema.agreements)
      .values({ id, storeId, requestId, version: (latest?.version ?? 0) + 1, terms, termsHash: hashTerms(terms), status: "proposed" })
      .returning();
    if (current) {
      await tx.update(schema.agreements).set({ status: "superseded", supersededById: id }).where(eq(schema.agreements.id, current.id));
    }
    await tx.update(schema.customRequests).set({ status: "agreement", updatedAt: new Date() }).where(eq(schema.customRequests.id, requestId));
    return created;
  });
}

/** Approve exactly the terms you saw: `hash` must equal the current terms hash. */
export async function approveAgreement(agreementId: string, party: "buyer" | "seller", hash: string, now = new Date()) {
  return withTx(async (tx) => {
    const [a] = await tx.select().from(schema.agreements).where(eq(schema.agreements.id, agreementId));
    if (!a) throw new AgreementError("agreement not found", 404);
    if (a.status === "approved" && a.holdUntil && a.holdUntil < now) throw new AgreementError("The approval expired. Please review the terms again.");
    if (a.status === "superseded") throw new AgreementError("These terms were replaced by a newer version. Please review the latest terms.");
    if (a.status !== "proposed" && a.status !== "approved") throw new AgreementError(`agreement is ${a.status}`);
    if (hash !== a.termsHash) throw new AgreementError("The terms changed since you viewed them. Please review again.");

    const patch = party === "buyer" ? { buyerApprovedHash: hash, buyerApprovedAt: now } : { sellerApprovedHash: hash, sellerApprovedAt: now };
    const buyerOk = (party === "buyer" ? hash : a.buyerApprovedHash) === a.termsHash;
    const sellerOk = (party === "seller" ? hash : a.sellerApprovedHash) === a.termsHash;
    const both = buyerOk && sellerOk;
    const [updated] = await tx
      .update(schema.agreements)
      .set({ ...patch, ...(both ? { status: "approved" as const, holdUntil: new Date(now.getTime() + HOLD_MS) } : {}) })
      .where(eq(schema.agreements.id, a.id))
      .returning();
    return updated;
  });
}

type AgreementRow = typeof schema.agreements.$inferSelect;

/**
 * An approved-but-unpaid agreement whose capacity hold has lapsed goes back to
 * "proposed" with both approvals cleared: the maker's time is released, and both
 * approve again (her approval re-checks capacity at that moment).
 */
export async function lapseIfExpired<T extends AgreementRow | undefined>(a: T, now = new Date()): Promise<T> {
  if (!a || a.status !== "approved" || !a.holdUntil || a.holdUntil >= now) return a;
  const d = await db();
  const [updated] = await d
    .update(schema.agreements)
    .set({ status: "proposed", buyerApprovedHash: null, buyerApprovedAt: null, sellerApprovedHash: null, sellerApprovedAt: null, holdUntil: null })
    .where(and(eq(schema.agreements.id, a.id), eq(schema.agreements.status, "approved")))
    .returning();
  return (updated ?? a) as T;
}

/** The single rule for "may this be paid": current version, both approvals on THIS hash, hold not lapsed. */
export function payableProblem(a: AgreementRow | undefined, now = new Date()): string | null {
  if (!a) return "agreement not found";
  if (a.status === "superseded") return "These terms were replaced by a newer version.";
  if (a.status === "paid") return "This agreement is already paid.";
  if (a.status !== "approved") return "Both the buyer and the maker must approve the terms first.";
  if (a.buyerApprovedHash !== a.termsHash || a.sellerApprovedHash !== a.termsHash) return "Approvals don't match these terms.";
  if (a.holdUntil && a.holdUntil < now) return "The approval expired. Please approve the terms again.";
  return null;
}

export async function createAgreementCheckout(agreementId: string, ctx: { appUrl: string; storeSlug: string }) {
  const d = await db();
  const [a] = await d.select().from(schema.agreements).where(eq(schema.agreements.id, agreementId));
  const problem = payableProblem(a);
  if (problem) throw new AgreementError(problem);
  const t = a!.terms as Terms;
  const money = (c: number) => (c / 100).toFixed(2);

  const order = await paypal<{ id: string; links?: { rel: string; href: string }[] }>("/v2/checkout/orders", {
    method: "POST",
    requestId: `agreement-${a!.id}-${a!.termsHash.slice(0, 16)}`, // same terms → same PayPal order on retry
    body: {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: a!.id,
          custom_id: a!.id,
          description: `Custom order v${a!.version}: ${t.quantity} × ${t.item}`.slice(0, 127),
          soft_descriptor: "HAAT",
          amount: {
            currency_code: "USD",
            value: money(t.totalUsdCents),
            breakdown: {
              item_total: { currency_code: "USD", value: money(t.unitPriceUsdCents * t.quantity) },
              shipping: { currency_code: "USD", value: money(t.shippingUsdCents) },
            },
          },
          items: [{ name: t.item.slice(0, 127), quantity: String(t.quantity), unit_amount: { currency_code: "USD", value: money(t.unitPriceUsdCents) }, category: "PHYSICAL_GOODS" }],
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: t.shop.slice(0, 127),
            shipping_preference: "GET_FROM_FILE",
            user_action: "PAY_NOW",
            return_url: `${ctx.appUrl}/api/checkout/return`,
            cancel_url: `${ctx.appUrl}/s/${ctx.storeSlug}/custom/${a!.requestId}`,
          },
        },
      },
    },
  });

  const existing = await d.select().from(schema.orders).where(eq(schema.orders.paypalOrderId, order.id));
  const saved =
    existing[0] ??
    (
      await d
        .insert(schema.orders)
        .values({
          storeId: a!.storeId,
          paypalOrderId: order.id,
          status: "CREATED",
          amountCents: t.totalUsdCents,
          shippingCents: t.shippingUsdCents,
          currency: "USD",
          items: [],
          channel: "custom",
          agreementId: a!.id,
          termsHash: a!.termsHash,
        })
        .returning()
    )[0];
  const approveUrl = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href ?? null;
  return { paypalOrderId: order.id, orderId: saved.id, approveUrl, totalUsdCents: t.totalUsdCents };
}

/** Called by EVERY capture path for agreement orders: the terms paid for must still be the approved, current ones. */
export async function assertCapturable(order: { agreementId: string | null; termsHash: string | null }) {
  if (!order.agreementId) return;
  const d = await db();
  const [a] = await d.select().from(schema.agreements).where(eq(schema.agreements.id, order.agreementId));
  if (a?.status === "paid" && a.termsHash === order.termsHash) return; // already captured (idempotent)
  const problem = payableProblem(a);
  if (problem) throw new AgreementError(`${problem} You have not been charged.`);
  if (a!.termsHash !== order.termsHash) throw new AgreementError("These terms changed after checkout started. You have not been charged.");
}

export async function markAgreementPaid(order: { id: string; agreementId: string | null; termsHash: string | null }) {
  if (!order.agreementId) return;
  const d = await db();
  const [a] = await d.select().from(schema.agreements).where(eq(schema.agreements.id, order.agreementId));
  if (!a || a.termsHash !== order.termsHash || a.status === "paid") return;
  await d.update(schema.agreements).set({ status: "paid", orderId: order.id }).where(eq(schema.agreements.id, a.id));
  await d.update(schema.customRequests).set({ status: "paid", updatedAt: new Date() }).where(eq(schema.customRequests.id, a.requestId));
}

export async function rulesFor(storeId: string) {
  const d = await db();
  const [store] = await d.select().from(schema.stores).where(eq(schema.stores.id, storeId));
  const e = readEconomics(store?.policy);
  return { store, e, inrPerUsd: env().INR_PER_USD };
}
