/**
 * Order lifecycle ordering. PayPal does not guarantee webhook delivery order and
 * the browser can race the webhook, so status may only ever move forward.
 */
const STATUS_RANK: Record<string, number> = {
  CREATED: 0,
  APPROVED: 1,
  PENDING: 2,
  DENIED: 3,
  /** Our record: PayPal refused to capture this order (422, e.g. a compliance check). No money moved; a new order is needed. */
  REFUSED: 3,
  COMPLETED: 3,
  PARTIALLY_REFUNDED: 4,
  REFUNDED: 5,
  REVERSED: 5,
};

export const CAPTURED_STATUSES = new Set(["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED", "REVERSED"]);

export function shouldAdvance(from: string, to: string): boolean {
  // A successful retry is final money movement even if an earlier capture failed.
  if ((from === "DENIED" || from === "REFUSED") && to === "COMPLETED") return true;
  // Partial refunds can repeat (each one is a new fact) and end in a full refund.
  if (from === "PARTIALLY_REFUNDED" && to === "PARTIALLY_REFUNDED") return true;
  if (from === to) return false;
  return (STATUS_RANK[to] ?? -1) > (STATUS_RANK[from] ?? -1);
}
