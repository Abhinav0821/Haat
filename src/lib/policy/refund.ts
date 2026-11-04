import { z } from "zod";

/**
 * Deterministic refund policy.
 *
 * The AI autopilot may *propose* a refund; this code decides whether it runs
 * automatically, needs the seller's tap, or is refused. The model never gets
 * to override these rules — "the model proposes, code disposes".
 */

export const StorePolicySchema = z.object({
  /** Refunds requested later than this many days after capture need the seller. */
  refundWindowDays: z.number().int().min(0).default(30),
  /** Refunds up to this amount may run without the seller. 0 = always ask. */
  autoRefundMaxCents: z.number().int().min(0).default(0),
  /** Above this amount, a photo of the problem is required for auto-approval. */
  photoEvidenceAboveCents: z.number().int().min(0).default(2000),
});

export type StorePolicy = z.infer<typeof StorePolicySchema>;

export function parsePolicy(raw: unknown): StorePolicy {
  return StorePolicySchema.parse(raw ?? {});
}

export type RefundRequest = {
  requestedCents: number;
  order: {
    status: string;
    amountCents: number;
    refundedCents: number;
    capturedAt: Date;
  };
  hasPhotoEvidence: boolean;
  now?: Date;
};

export type RefundDecision = {
  outcome: "auto_approve" | "needs_approval" | "reject";
  amountCents: number;
  reasons: string[];
};

const REFUNDABLE_STATUSES = new Set(["COMPLETED", "PARTIALLY_REFUNDED"]);
const DAY_MS = 86_400_000;
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

export function decideRefund(req: RefundRequest, policy: StorePolicy): RefundDecision {
  const { requestedCents: amount, order } = req;
  const now = req.now ?? new Date();

  // Hard rules → reject. These protect money regardless of what anyone asks.
  if (!Number.isInteger(amount) || amount <= 0) {
    return { outcome: "reject", amountCents: amount, reasons: ["refund amount must be a positive whole number of cents"] };
  }
  if (!REFUNDABLE_STATUSES.has(order.status)) {
    return { outcome: "reject", amountCents: amount, reasons: [`order is ${order.status}; only captured orders can be refunded`] };
  }
  const remaining = order.amountCents - order.refundedCents;
  if (amount > remaining) {
    return {
      outcome: "reject",
      amountCents: amount,
      reasons: [`${usd(amount)} exceeds the refundable balance of ${usd(remaining)}`],
    };
  }

  // Soft rules → escalate to the seller.
  const reasons: string[] = [];
  const ageDays = Math.floor((now.getTime() - order.capturedAt.getTime()) / DAY_MS);
  if (ageDays > policy.refundWindowDays) {
    reasons.push(`requested ${ageDays} days after payment (window is ${policy.refundWindowDays})`);
  }
  if (amount > policy.autoRefundMaxCents) {
    reasons.push(
      policy.autoRefundMaxCents === 0
        ? "store requires seller approval for every refund"
        : `${usd(amount)} is above the auto-refund limit of ${usd(policy.autoRefundMaxCents)}`,
    );
  }
  if (amount > policy.photoEvidenceAboveCents && !req.hasPhotoEvidence) {
    reasons.push(`no photo evidence for a refund above ${usd(policy.photoEvidenceAboveCents)}`);
  }

  return reasons.length
    ? { outcome: "needs_approval", amountCents: amount, reasons }
    : { outcome: "auto_approve", amountCents: amount, reasons: ["within policy"] };
}
