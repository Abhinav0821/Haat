import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { db, schema, withTx, type DB, type Tx } from "@/db";
import { CollectiveError, lockOrderTree, memberByLink } from "./service";

/**
 * What the collective owes each maker, and what it has paid her. Three distinct states:
 *
 *  - OWED: her share, created once when the buyer's payment is captured, from her accepted
 *    part (id and hash). Nothing else creates or changes it.
 *  - REPORTED: the coordinator says she paid an amount, with its UPI or bank reference.
 *    That is a claim, not a payment.
 *  - CONFIRMED: she says she received it, on her personal link. Only she can do this, and
 *    it is final. She can instead say she didn't receive it (disputed); a disputed payment
 *    never counts as paid. Haat does not check UPI or bank records: "confirmed" means
 *    confirmed by her, not verified with a bank.
 *
 * Reported + disputed + confirmed can never exceed what she is owed; a reference is used
 * once per collective; the coordinator can withdraw a record she hasn't confirmed.
 * Every write takes the order's locks (collective first), so these checks can't race.
 */

type PaymentRow = typeof schema.makerPayments.$inferSelect;
type ShareRow = typeof schema.makerShares.$inferSelect;

/** UPI transaction references (UTR/RRN) are 12 digits; bank UTRs (IMPS/NEFT/RTGS) are 12–22 letters and digits. */
export function normaliseReference(method: unknown, raw: unknown): { method: "upi" | "bank"; reference: string } {
  if (method !== "upi" && method !== "bank") throw new CollectiveError("Choose UPI or bank transfer.", 400);
  const reference = String(raw ?? "").replace(/[\s-]/g, "").toUpperCase();
  if (method === "upi" && !/^\d{12}$/.test(reference)) throw new CollectiveError("A UPI reference is the 12-digit transaction number (UTR).", 400);
  if (method === "bank" && !/^[A-Z0-9]{12,22}$/.test(reference)) throw new CollectiveError("A bank reference (UTR) is 12 to 22 letters and digits.", 400);
  return { method, reference };
}

export function toPaise(amountInr: unknown): number {
  const n = typeof amountInr === "number" ? amountInr : Number(String(amountInr ?? "").replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) throw new CollectiveError("Enter an amount above zero.", 400);
  const paise = Math.round(n * 100);
  if (Math.abs(paise - n * 100) > 1e-6) throw new CollectiveError("Use at most two decimal places.", 400);
  return paise;
}

const COUNTED: PaymentRow["status"][] = ["reported", "confirmed", "disputed"];

export type ShareSummary = {
  shareId: string;
  memberId: string;
  partId: string;
  owedPaise: number;
  confirmedPaise: number;
  awaitingPaise: number;
  disputedPaise: number;
  /** Not yet reported at all. */
  leftPaise: number;
  settled: boolean;
  payments: { id: string; amountPaise: number; method: "upi" | "bank"; reference: string; reportedBy: string; reportedAt: string; status: PaymentRow["status"]; respondedAt: string | null; note: string | null }[];
};

export function summariseShare(share: ShareRow, payments: PaymentRow[]): ShareSummary {
  const mine = payments.filter((p) => p.shareId === share.id).sort((a, b) => a.reportedAt.getTime() - b.reportedAt.getTime());
  const sum = (s: PaymentRow["status"]) => mine.filter((p) => p.status === s).reduce((t, p) => t + p.amountPaise, 0);
  const confirmedPaise = sum("confirmed"), awaitingPaise = sum("reported"), disputedPaise = sum("disputed");
  return {
    shareId: share.id,
    memberId: share.memberId,
    partId: share.partId,
    owedPaise: share.owedPaise,
    confirmedPaise,
    awaitingPaise,
    disputedPaise,
    leftPaise: share.owedPaise - confirmedPaise - awaitingPaise - disputedPaise,
    settled: confirmedPaise === share.owedPaise,
    payments: mine.map((p) => ({
      id: p.id,
      amountPaise: p.amountPaise,
      method: p.method,
      reference: p.reference,
      reportedBy: p.reportedBy,
      reportedAt: p.reportedAt.toISOString(),
      status: p.status,
      respondedAt: p.respondedAt?.toISOString() ?? null,
      note: p.note,
    })),
  };
}

/** Shares (with payments) for a plan, or for one maker. */
export async function shareSummaries(q: DB | Tx, where: { planId?: string; memberId?: string }): Promise<ShareSummary[]> {
  const shares = await q
    .select()
    .from(schema.makerShares)
    .where(and(where.planId ? eq(schema.makerShares.planId, where.planId) : undefined, where.memberId ? eq(schema.makerShares.memberId, where.memberId) : undefined))
    .orderBy(asc(schema.makerShares.createdAt));
  if (!shares.length) return [];
  const payments = await q.select().from(schema.makerPayments).where(inArray(schema.makerPayments.shareId, shares.map((s) => s.id)));
  return shares.map((s) => summariseShare(s, payments));
}

async function shareOrderId(shareId: string) {
  const [s] = await (await db()).select({ orderId: schema.makerShares.orderId }).from(schema.makerShares).where(eq(schema.makerShares.id, shareId));
  if (!s) throw new CollectiveError("This share wasn't found.", 404);
  return s.orderId;
}

/** The coordinator reports a payment she made to a maker. A claim until the maker confirms it. */
export async function reportMakerPayment(shareId: string, input: { amountInr: unknown; method: unknown; reference: unknown }, by: { name: string }, now = new Date()) {
  const amountPaise = toPaise(input.amountInr);
  const { method, reference } = normaliseReference(input.method, input.reference);
  const orderId = await shareOrderId(shareId);
  return withTx(async (tx) => {
    const collectiveId = await lockOrderTree(tx, orderId);
    const [share] = await tx.select().from(schema.makerShares).where(eq(schema.makerShares.id, shareId));
    if (!share) throw new CollectiveError("This share wasn't found.", 404);
    const [plan] = await tx.select({ status: schema.collectivePlans.status }).from(schema.collectivePlans).where(eq(schema.collectivePlans.id, share.planId));
    if (plan?.status !== "paid") throw new CollectiveError("Makers are paid only for a paid order.");
    const payments = await tx.select().from(schema.makerPayments).where(and(eq(schema.makerPayments.shareId, share.id), inArray(schema.makerPayments.status, COUNTED)));
    const room = share.owedPaise - payments.reduce((t, p) => t + p.amountPaise, 0);
    if (amountPaise > room) {
      throw new CollectiveError(room <= 0 ? "Her whole share is already reported. Withdraw a record first if one is wrong." : `That's more than is left to report for her (₹${(room / 100).toLocaleString("en-IN")}).`, 400);
    }
    const [reused] = await tx
      .select({ id: schema.makerPayments.id })
      .from(schema.makerPayments)
      .where(and(eq(schema.makerPayments.collectiveId, collectiveId), eq(schema.makerPayments.reference, reference), ne(schema.makerPayments.status, "withdrawn")));
    if (reused) throw new CollectiveError("This reference is already recorded for another payment. Each transfer has its own reference.", 400);
    const [created] = await tx
      .insert(schema.makerPayments)
      .values({ shareId: share.id, collectiveId, memberId: share.memberId, amountPaise, method, reference, reportedBy: by.name.slice(0, 80), reportedAt: now, status: "reported" })
      .returning();
    return created;
  });
}

/** The coordinator withdraws a record she hasn't confirmed (a typo, or a transfer that bounced). */
export async function withdrawMakerPayment(paymentId: string) {
  const [p] = await (await db()).select({ shareId: schema.makerPayments.shareId }).from(schema.makerPayments).where(eq(schema.makerPayments.id, paymentId));
  if (!p) throw new CollectiveError("This payment record wasn't found.", 404);
  const orderId = await shareOrderId(p.shareId);
  return withTx(async (tx) => {
    await lockOrderTree(tx, orderId);
    const [row] = await tx.select().from(schema.makerPayments).where(eq(schema.makerPayments.id, paymentId));
    if (!row) throw new CollectiveError("This payment record wasn't found.", 404);
    if (row.status === "confirmed") throw new CollectiveError("She confirmed this payment, so it can't be withdrawn.");
    if (row.status === "withdrawn") return row;
    const [u] = await tx.update(schema.makerPayments).set({ status: "withdrawn" }).where(eq(schema.makerPayments.id, row.id)).returning();
    return u;
  });
}

/** Her answer, on her personal link: received (final) or not received. */
export async function respondToPayment(token: string, paymentId: string, answer: "confirm" | "dispute", note: string | null = null, now = new Date()) {
  const member = await memberByLink(token);
  const [p] = await (await db()).select({ shareId: schema.makerPayments.shareId, memberId: schema.makerPayments.memberId }).from(schema.makerPayments).where(eq(schema.makerPayments.id, paymentId));
  if (!p || p.memberId !== member.id) throw new CollectiveError("This payment record wasn't found.", 404); // never reveal another maker's payments
  const orderId = await shareOrderId(p.shareId);
  return withTx(async (tx) => {
    await lockOrderTree(tx, orderId);
    await memberByLink(token, tx); // a link revoked while waiting cannot answer
    const [row] = await tx.select().from(schema.makerPayments).where(eq(schema.makerPayments.id, paymentId));
    if (!row || row.memberId !== member.id) throw new CollectiveError("This payment record wasn't found.", 404);
    if (row.status === "withdrawn") throw new CollectiveError("The coordinator withdrew this payment record.");
    if (row.status === "confirmed") {
      if (answer === "confirm") return row;
      throw new CollectiveError("You already confirmed this payment.");
    }
    if (row.status === "disputed" && answer === "dispute") return row;
    const [u] = await tx
      .update(schema.makerPayments)
      .set({ status: answer === "confirm" ? "confirmed" : "disputed", respondedAt: now, respondedVia: "personal_link", note: note?.trim().slice(0, 300) || null })
      .where(eq(schema.makerPayments.id, row.id))
      .returning();
    return u;
  });
}
