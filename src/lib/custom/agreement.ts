import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { db, schema, withTx, type DB, type Tx } from "@/db";
import { readEconomics, type Economics } from "@/lib/economics";
import { env } from "@/lib/env";
import { logEvent } from "@/lib/events";
import { canonical } from "@/lib/passport/signing";
import { paypal } from "@/lib/paypal/client";
import type { PayPalOrderSnapshot } from "@/lib/paypal/finalize";
import type { CustomSpec, OptionVerdict } from "./quote";

/**
 * Custom-order agreements: one immutable set of terms that BOTH people approve.
 *
 *  - Terms are frozen and hashed (SHA-256 of canonical JSON). They hold BOTH
 *    languages, so the buyer's English view and her Hindi read-back are
 *    rendered from the same approved content.
 *  - An approval records the hash it approved; it only counts for that hash.
 *  - Any change creates a new version; the old one is superseded and its
 *    approvals no longer count.
 *  - Becoming fully approved re-checks her capacity and earnings atomically
 *    (store-level lock), whichever party approves last.
 *  - Capture: the version is locked as "paying" before PayPal is called. While
 *    paying, nothing can revise, decline or re-approve it; the outcome (paid,
 *    failed, or reconciled with PayPal) is recorded against that exact version.
 */

export const HOLD_MS = 48 * 3600_000; // capacity held after approval while unpaid
export const PAYING_STALE_MS = 10 * 60_000; // an unresolved capture older than this is reconciled with PayPal

const HANDMADE_EN = "Each piece is printed by hand: small differences in colour and pattern between pieces are part of handmade work.";
const HANDMADE_HI = "हर पीस हाथ से छपता है, इसलिए पीस के बीच रंग और डिज़ाइन में थोड़ा फ़र्क़ होना हाथ के काम का हिस्सा है।";
const REFUND_EN = "Made to order, so no returns for change of mind. Pieces that arrive damaged or not as agreed are refunded under the maker's refund policy.";
const REFUND_HI = "ऑर्डर पर बना है, इसलिए मन बदलने पर वापसी नहीं। ख़राब या तय शर्तों से अलग पहुँचे तो आपकी रिफ़ंड नीति लागू होगी।";

export type Bilingual = { en: string; hi: string | null };

export type Terms = {
  v: 1 | 2;
  shop: string;
  maker: string;
  item: string;
  /** v2: the item in Hindi, as she hears it. */
  itemHi?: string | null;
  quantity: number;
  unitPriceUsdCents: number;
  shippingUsdCents: number;
  totalUsdCents: number;
  colors: string[];
  materials: string[];
  /** v2: Hindi words for colours/materials (same order), when known. */
  colorsHi?: string[] | null;
  materialsHi?: string[] | null;
  completionBy: string;
  deliveryEstimate: string;
  handmadeVariation: string;
  refundTerms: string;
  /** v2: Hindi versions of the fixed clauses, so both readings carry them. */
  handmadeVariationHi?: string;
  refundTermsHi?: string;
  /** v2: the buyer's stated requirements (e.g. "exactly 2 metres long"). */
  requirements?: Bilingual[];
  /** The maker's own condition (e.g. "dry clean only"); v2 also in her words. */
  note: string | null;
  noteHi?: string | null;
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

type SpecHi = CustomSpec & { itemHi?: string; colorsHi?: string[]; materialsHi?: string[]; otherWishes?: string | null; otherWishesHi?: string | null };

export function buildTerms(v: OptionVerdict, req: SpecHi, shop: { name: string; ownerName: string }, e: Economics): Terms {
  const colors = v.option.colors ?? req.colors;
  const materials = v.option.materials ?? req.materials;
  // Hindi words only if they belong to exactly these colours/materials.
  const sameList = (a: string[], b: string[]) => a.join("|") === b.join("|");
  const colorsHi = sameList(colors, req.colors) && req.colorsHi?.length === colors.length ? req.colorsHi : null;
  const materialsHi = sameList(materials, req.materials) && req.materialsHi?.length === materials.length ? req.materialsHi : null;
  const wishes = req.otherWishes?.trim();
  return {
    v: 2,
    shop: shop.name,
    maker: shop.ownerName,
    item: req.item,
    itemHi: req.itemHi ?? null,
    quantity: v.option.quantity,
    unitPriceUsdCents: v.option.unitPriceUsdCents,
    shippingUsdCents: e.shippingChargeUsdCents,
    totalUsdCents: v.option.unitPriceUsdCents * v.option.quantity + e.shippingChargeUsdCents,
    colors,
    materials,
    colorsHi,
    materialsHi,
    completionBy: v.completion,
    deliveryEstimate: v.delivery,
    handmadeVariation: HANDMADE_EN,
    handmadeVariationHi: HANDMADE_HI,
    refundTerms: REFUND_EN,
    refundTermsHi: REFUND_HI,
    requirements: wishes ? [{ en: wishes, hi: req.otherWishesHi?.trim() || null }] : [],
    note: v.option.note,
    noteHi: v.option.noteHi ?? null,
  };
}

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const longDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** The buyer's reading of the terms. Every clause in the terms appears here. */
export function termsLinesEn(t: Terms): [string, string][] {
  const reqs = t.requirements ?? [];
  return [
    ["Item", `${t.quantity} × ${t.item}`],
    ["Colours / materials", [...t.colors, ...t.materials].join(", ") || "—"],
    ...(reqs.length ? ([["Your requirements", reqs.map((r) => r.en).join(" · ")]] as [string, string][]) : []),
    ["Price", `${usd(t.unitPriceUsdCents)} each · ${usd(t.unitPriceUsdCents * t.quantity)} for ${t.quantity}`],
    ["Shipping", usd(t.shippingUsdCents)],
    ["Total", usd(t.totalUsdCents)],
    ["Made by", longDate(t.completionBy)],
    ["Estimated delivery", `${longDate(t.deliveryEstimate)} (estimate — courier times vary)`],
    ["Handmade variation", t.handmadeVariation],
    ["Refunds", t.refundTerms],
    ...(t.note ? ([["Maker's condition", t.note]] as [string, string][]) : []),
  ];
}

/** Her reading of the same terms, read aloud (fixed template; every clause included). */
export function termsHi(t: Terms, inrPerUsd: number): string {
  const day = (iso: string) => new Date(iso).toLocaleDateString("hi-IN", { day: "numeric", month: "long", timeZone: "UTC" });
  const inr = Math.round((t.totalUsdCents / 100) * inrPerUsd).toLocaleString("en-IN");
  const colors = t.colorsHi?.length === t.colors.length ? t.colorsHi : t.colors;
  const materials = t.materialsHi?.length === t.materials.length ? t.materialsHi : t.materials;
  const parts = [
    `समझौता: ${t.quantity} पीस ${t.itemHi || t.item}${[...colors, ...materials].length ? `, ${[...colors, ...materials].join(", ")}` : ""}।`,
  ];
  for (const r of t.requirements ?? []) parts.push(`ख़रीदार की शर्त: ${r.hi || r.en}।`);
  parts.push(
    `हर पीस ${(t.unitPriceUsdCents / 100).toFixed(2)} डॉलर, शिपिंग ${(t.shippingUsdCents / 100).toFixed(2)} डॉलर, कुल ${(t.totalUsdCents / 100).toFixed(2)} डॉलर, यानी लगभग ${inr} रुपये।`,
    `${day(t.completionBy)} तक बनाना है, पहुँचने का अनुमान ${day(t.deliveryEstimate)}।`,
  );
  if (t.note || t.noteHi) parts.push(`आपकी शर्त: ${t.noteHi || t.note}।`);
  parts.push(t.handmadeVariationHi ?? HANDMADE_HI, t.refundTermsHi ?? REFUND_HI);
  return parts.join(" ").replace(/।।/g, "।");
}

/**
 * Pieces still to make: her stated backlog + approved (held) and in-payment
 * agreements + paid ones not yet finished. Pass `tx` to read inside a transaction.
 */
export async function effectiveBacklog(
  storeId: string,
  e: Economics,
  opts: { now?: Date; excludeRequestId?: string; tx?: Tx | DB } = {},
): Promise<number> {
  const d = opts.tx ?? (await db());
  const now = opts.now ?? new Date();
  const rows = await d
    .select({ terms: schema.agreements.terms, requestId: schema.agreements.requestId, status: schema.agreements.status, piecesDone: schema.agreements.piecesDone })
    .from(schema.agreements)
    .where(
      and(
        eq(schema.agreements.storeId, storeId),
        or(
          inArray(schema.agreements.status, ["paid", "paying"]),
          and(eq(schema.agreements.status, "approved"), gt(schema.agreements.holdUntil, now)),
        ),
      ),
    );
  const remaining = (r: (typeof rows)[number]) => Math.max(0, ((r.terms as Terms).quantity ?? 0) - (r.status === "paid" ? r.piecesDone : 0));
  return e.backlogPieces + rows.filter((r) => r.requestId !== opts.excludeRequestId).reduce((s, r) => s + remaining(r), 0);
}

/**
 * LOCK ORDER — the same everywhere an agreement's state changes (revise, decline,
 * approve, start/finish/end a capture): the custom request row FIRST, then the
 * agreement row. Consistent order means these operations serialise instead of
 * interleaving (or deadlocking), and state is re-read only after both locks.
 */
const lockRequest = (tx: Tx, requestId: string) => tx.execute(sql`select id from custom_requests where id = ${requestId} for update`);
const lockAgreement = async (tx: Tx, id: string) => {
  const [ref] = await tx.select({ requestId: schema.agreements.requestId }).from(schema.agreements).where(eq(schema.agreements.id, id)); // immutable
  if (!ref) return undefined;
  await lockRequest(tx, ref.requestId);
  await tx.execute(sql`select id from agreements where id = ${id} for update`);
  const [a] = await tx.select().from(schema.agreements).where(eq(schema.agreements.id, id));
  return a;
};

/** Test-only pause points, used to force interleavings in concurrency tests. */
export type Hooks = { afterRead?: () => Promise<void> };

export async function proposeAgreement(requestId: string, storeId: string, terms: Terms, hooks: Hooks = {}) {
  return withTx(async (tx) => {
    // Same lock order as capture: request, then its agreements — then read.
    await lockRequest(tx, requestId);
    await tx.execute(sql`select id from agreements where request_id = ${requestId} for update`);
    const versions = await tx.select().from(schema.agreements).where(eq(schema.agreements.requestId, requestId)).orderBy(desc(schema.agreements.version));
    await hooks.afterRead?.();
    if (versions.some((a) => a.status === "paying")) throw new AgreementError("A payment for the current terms is being processed — the terms can't change now.");
    if (versions.some((a) => a.status === "paid")) throw new AgreementError("This order is already paid.");
    const current = versions.find((a) => a.status === "proposed" || a.status === "approved");
    const id = randomUUID();
    const [created] = await tx
      .insert(schema.agreements)
      .values({ id, storeId, requestId, version: (versions[0]?.version ?? 0) + 1, terms, termsHash: hashTerms(terms), status: "proposed" })
      .returning();
    if (current) {
      // Conditional as a second guard: only a version that is still proposed/approved can be superseded.
      const superseded = await tx
        .update(schema.agreements)
        .set({ status: "superseded", supersededById: id })
        .where(and(eq(schema.agreements.id, current.id), inArray(schema.agreements.status, ["proposed", "approved"])))
        .returning({ id: schema.agreements.id });
      if (!superseded.length) throw new AgreementError("The current terms changed while revising — please try again.");
    }
    await tx.update(schema.customRequests).set({ status: "agreement", updatedAt: new Date() }).where(eq(schema.customRequests.id, requestId));
    return created;
  });
}

type AgreementRow = typeof schema.agreements.$inferSelect;

/** Re-checks run at the moment terms become fully approved (inside the approval transaction). */
export type FinalCheck = (tx: Tx, a: AgreementRow) => Promise<string | null>;

class FinalCheckFailed extends Error {}

/**
 * Approve exactly the terms you saw: `hash` must equal the current terms hash.
 * When this approval makes the terms fully approved, `finalCheck` runs under a
 * store-level lock, so two agreements can't both claim the same capacity —
 * whichever party approves last. If it fails, her approval is cleared (the terms
 * need revising) and nothing is held.
 */
export async function approveAgreement(agreementId: string, party: "buyer" | "seller", hash: string, opts: { now?: Date; finalCheck?: FinalCheck } = {}) {
  const now = opts.now ?? new Date();
  try {
    return await withTx(async (tx) => {
      const a = await lockAgreement(tx, agreementId);
      if (!a) throw new AgreementError("agreement not found", 404);
      if (a.status === "paying") throw new AgreementError("A payment for these terms is being processed.");
      if (a.status === "approved" && a.holdUntil && a.holdUntil < now) throw new AgreementError("The approval expired. Please review the terms again.");
      if (a.status === "superseded") throw new AgreementError("These terms were replaced by a newer version. Please review the latest terms.");
      if (a.status !== "proposed" && a.status !== "approved") throw new AgreementError(`agreement is ${a.status}`);
      if (hash !== a.termsHash) throw new AgreementError("The terms changed since you viewed them. Please review again.");

      const patch = party === "buyer" ? { buyerApprovedHash: hash, buyerApprovedAt: now } : { sellerApprovedHash: hash, sellerApprovedAt: now };
      const buyerOk = (party === "buyer" ? hash : a.buyerApprovedHash) === a.termsHash;
      const sellerOk = (party === "seller" ? hash : a.sellerApprovedHash) === a.termsHash;
      if (a.status === "approved" && buyerOk && sellerOk) return a; // already fully approved: no extension of the hold
      const becomesApproved = buyerOk && sellerOk;
      if (becomesApproved && opts.finalCheck) {
        await tx.execute(sql`select id from stores where id = ${a.storeId} for update`); // one final approval per shop at a time
        const problem = await opts.finalCheck(tx, a);
        if (problem) throw new FinalCheckFailed(problem);
      }
      const [updated] = await tx
        .update(schema.agreements)
        .set({ ...patch, ...(buyerOk && sellerOk ? { status: "approved" as const, holdUntil: new Date(now.getTime() + HOLD_MS) } : {}) })
        .where(eq(schema.agreements.id, a.id))
        .returning();
      return updated;
    });
  } catch (e) {
    if (!(e instanceof FinalCheckFailed)) throw e;
    // The terms no longer fit her rules: clear her approval so she revises them.
    const d = await db();
    await d.update(schema.agreements).set({ sellerApprovedHash: null, sellerApprovedAt: null }).where(eq(schema.agreements.id, agreementId));
    throw new AgreementError(`These terms no longer fit the maker's schedule or costs (${e.message}) She will send revised terms; nothing was charged.`);
  }
}

/**
 * An approved-but-unpaid agreement whose capacity hold has lapsed goes back to
 * "proposed" with both approvals cleared: the maker's time is released, and both
 * approve again (which re-checks capacity).
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
  if (a.status === "paying") return "A payment for these terms is already being processed.";
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

type OrderRef = { id: string; agreementId: string | null; termsHash: string | null };

/**
 * Called by EVERY capture path for agreement orders, BEFORE PayPal is asked to capture.
 * Atomically checks the terms are the current, fully approved version this order was
 * created for, and locks them as "paying". Returns "already_paid" for a repeat capture.
 */
export async function beginAgreementCapture(order: OrderRef, now = new Date(), hooks: Hooks = {}): Promise<"ok" | "already_paid" | "none"> {
  if (!order.agreementId) return "none";
  return withTx(async (tx) => {
    const a = await lockAgreement(tx, order.agreementId!);
    await hooks.afterRead?.();
    if (!a) throw new AgreementError("agreement not found. You have not been charged.");
    if (a.termsHash !== order.termsHash) throw new AgreementError("These terms changed after checkout started. You have not been charged.");
    if (a.status === "paid") {
      if (a.orderId === order.id) return "already_paid";
      throw new AgreementError("This agreement was already paid with another payment. You have not been charged.");
    }
    if (a.status === "paying") {
      if (a.orderId === order.id) return "ok"; // retry of the same capture (PayPal capture is idempotent)
      throw new AgreementError("Another payment for these terms is in progress. You have not been charged.");
    }
    const problem = payableProblem(a, now);
    if (problem) throw new AgreementError(`${problem} You have not been charged.`);
    await tx.update(schema.agreements).set({ status: "paying", payingSince: now, orderId: order.id }).where(eq(schema.agreements.id, a.id));
    return "ok";
  });
}

/** The capture definitely did not take money: the terms go back to approved (still held, if the hold hasn't lapsed). */
export async function endAgreementCapture(order: OrderRef) {
  if (!order.agreementId) return;
  await withTx(async (tx) => {
    const a = await lockAgreement(tx, order.agreementId!);
    if (!a || a.status !== "paying" || a.orderId !== order.id) return;
    await tx.update(schema.agreements).set({ status: "approved", payingSince: null, orderId: null }).where(eq(schema.agreements.id, a.id));
  });
}

/**
 * Money was captured for this order: record it against the EXACT version it was
 * created for. With "paying" locking revisions this is the current version; if a
 * newer version somehow exists, the charged one still wins (the buyer paid for it)
 * and newer unpaid versions are cancelled, and the event is logged for review.
 */
export async function markAgreementPaid(order: OrderRef) {
  if (!order.agreementId) return;
  await withTx(async (tx) => {
    const a = await lockAgreement(tx, order.agreementId!);
    if (!a || a.termsHash !== order.termsHash) return;
    if (a.status === "paid") return;
    await tx.update(schema.agreements).set({ status: "paid", orderId: order.id, payingSince: null }).where(eq(schema.agreements.id, a.id));
    const newer = await tx
      .update(schema.agreements)
      .set({ status: "cancelled" })
      .where(and(eq(schema.agreements.requestId, a.requestId), ne(schema.agreements.id, a.id), inArray(schema.agreements.status, ["proposed", "approved"])))
      .returning({ id: schema.agreements.id });
    await tx.update(schema.customRequests).set({ status: "paid", updatedAt: new Date() }).where(eq(schema.customRequests.id, a.requestId));
    if (a.status === "superseded" || newer.length) {
      await logEvent("agreement_paid_while_revised", { agreementId: a.id, cancelledNewer: newer.length }, a.storeId);
    }
  });
}

/** PayPal order states in which no capture can have happened. */
const NEVER_CAPTURED = new Set(["CREATED", "SAVED", "APPROVED", "PAYER_ACTION_REQUIRED", "VOIDED"]);

/**
 * A "paying" agreement whose capture outcome never arrived (crash, timeout, lost
 * webhook) is reconciled with PayPal's own order record once it's stale, through
 * the same finalisation as every other capture path (order status, capture id,
 * capture time, fees, buyer/shipping details, stock, agreement):
 *  - capture COMPLETED → paid;  capture PENDING → stays "paying";
 *  - capture DENIED → back to approved;
 *  - no capture and PayPal says the order was never captured → back to approved;
 *  - anything ambiguous (e.g. order COMPLETED but no capture record) → stays "paying".
 */
export async function reconcileIfStale<T extends AgreementRow | undefined>(
  a: T,
  deps: { now?: Date; lookup?: (paypalOrderId: string) => Promise<PayPalOrderSnapshot> } = {},
): Promise<T> {
  const now = deps.now ?? new Date();
  if (!a || a.status !== "paying" || !a.payingSince || now.getTime() - a.payingSince.getTime() < PAYING_STALE_MS || !a.orderId) return a;
  const d = await db();
  const [order] = await d.select().from(schema.orders).where(eq(schema.orders.id, a.orderId));
  if (!order) return a;
  try {
    const pp = await (deps.lookup ?? ((id: string) => paypal<PayPalOrderSnapshot>(`/v2/checkout/orders/${encodeURIComponent(id)}`)))(order.paypalOrderId);
    const { finalizePayment, captureOutcome } = await import("@/lib/paypal/finalize");
    if (captureOutcome(pp).outcome !== "UNKNOWN") await finalizePayment(order.id, pp, now);
    else if (!pp.purchase_units?.[0]?.payments?.captures?.length && NEVER_CAPTURED.has(pp.status ?? "")) await endAgreementCapture(order);
    // else: ambiguous — keep the terms locked rather than guess.
  } catch (e) {
    console.warn("[agreement] reconcile failed:", (e as Error).message);
    return a;
  }
  const [fresh] = await d.select().from(schema.agreements).where(eq(schema.agreements.id, a.id));
  return (fresh ?? a) as T;
}

export async function rulesFor(storeId: string) {
  const d = await db();
  const [store] = await d.select().from(schema.stores).where(eq(schema.stores.id, storeId));
  const e = readEconomics(store?.policy);
  return { store, e, inrPerUsd: env().INR_PER_USD };
}
