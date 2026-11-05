import { and, eq, gt, ne, sql } from "drizzle-orm";
import { db, schema, withTx, type Tx } from "@/db";

/**
 * Stock for one-of-a-kind and small-batch pieces.
 *
 *  - reserve():  at order creation, under a row lock on the product, so two
 *                simultaneous buyers (or AI agents) can't both take the last piece.
 *  - ensureReservedForCapture(): EVERY capture path calls this before charging.
 *                If the hold expired while the buyer was on PayPal, the piece is
 *                re-held only if it's still free — otherwise we refuse to capture
 *                (the buyer is never charged; PayPal lets the approval lapse).
 *  - consume():  after a successful capture (browser, return URL or webhook).
 *                Idempotent, so duplicate webhooks and retries count a sale once.
 *  - release():  when a payment is denied or abandoned.
 */

export const RESERVATION_TTL_MS = 20 * 60_000;

export class SoldOutError extends Error {
  constructor() {
    super("This piece has just been bought by someone else. You have not been charged.");
  }
}

async function lockProduct(tx: Tx, productId: string) {
  // Row lock: concurrent reservations for the same product queue up here.
  await tx.execute(sql`select id from products where id = ${productId} for update`);
  const [p] = await tx.select().from(schema.products).where(eq(schema.products.id, productId));
  if (!p) throw new Error("product not found");
  return p;
}

async function heldByOthers(tx: Tx, productId: string, exceptOrderId: string | null, now: Date) {
  const rows = await tx
    .select({ qty: schema.reservations.qty })
    .from(schema.reservations)
    .where(
      and(
        eq(schema.reservations.productId, productId),
        eq(schema.reservations.status, "active"),
        gt(schema.reservations.expiresAt, now),
        ...(exceptOrderId ? [ne(schema.reservations.orderId, exceptOrderId)] : []),
      ),
    );
  return rows.reduce((s, r) => s + r.qty, 0);
}

export async function availableQuantity(productId: string, now = new Date()): Promise<{ available: number; held: number; sold: number; total: number }> {
  const d = await db();
  const [p] = await d.select().from(schema.products).where(eq(schema.products.id, productId));
  if (!p) return { available: 0, held: 0, sold: 0, total: 0 };
  const rows = await d
    .select({ qty: schema.reservations.qty })
    .from(schema.reservations)
    .where(and(eq(schema.reservations.productId, productId), eq(schema.reservations.status, "active"), gt(schema.reservations.expiresAt, now)));
  const held = rows.reduce((s, r) => s + r.qty, 0);
  return { available: Math.max(0, p.quantity - p.soldQuantity - held), held, sold: p.soldQuantity, total: p.quantity };
}

export async function reserve(productId: string, qty: number, orderId: string, ttlMs = RESERVATION_TTL_MS, now = new Date()) {
  return withTx(async (tx) => {
    const p = await lockProduct(tx, productId);
    const free = p.quantity - p.soldQuantity - (await heldByOthers(tx, productId, null, now));
    if (free < qty) throw new SoldOutError();
    const [r] = await tx
      .insert(schema.reservations)
      .values({ productId, orderId, qty, status: "active", expiresAt: new Date(now.getTime() + ttlMs) })
      .returning();
    return r;
  });
}

/** Must succeed before any capture. Returns false only for legacy orders without stock tracking. */
export async function ensureReservedForCapture(orderId: string, now = new Date()): Promise<boolean> {
  return withTx(async (tx) => {
    const [r] = await tx.select().from(schema.reservations).where(eq(schema.reservations.orderId, orderId));
    if (!r) return false;
    if (r.status === "consumed") return true;
    if (r.status === "active" && r.expiresAt > now) return true;

    // Hold expired or was released while the buyer was on PayPal: re-hold only if still free.
    const p = await lockProduct(tx, r.productId);
    const free = p.quantity - p.soldQuantity - (await heldByOthers(tx, r.productId, orderId, now));
    if (free < r.qty) {
      await tx.update(schema.reservations).set({ status: "released" }).where(eq(schema.reservations.id, r.id));
      throw new SoldOutError();
    }
    await tx
      .update(schema.reservations)
      .set({ status: "active", expiresAt: new Date(now.getTime() + RESERVATION_TTL_MS) })
      .where(eq(schema.reservations.id, r.id));
    return true;
  });
}

/** Payment captured: count the sale exactly once. */
export async function consume(orderId: string) {
  return withTx(async (tx) => {
    // Claim the reservation with ONE conditional update. Under concurrency (browser
    // capture + webhook + return URL) Postgres re-checks the condition after the
    // first transaction commits, so only one caller gets the row back and counts the sale.
    const [r] = await tx
      .update(schema.reservations)
      .set({ status: "consumed" })
      .where(and(eq(schema.reservations.orderId, orderId), ne(schema.reservations.status, "consumed")))
      .returning();
    if (!r) return false;
    await lockProduct(tx, r.productId);
    await tx
      .update(schema.products)
      .set({ soldQuantity: sql`${schema.products.soldQuantity} + ${r.qty}` })
      .where(eq(schema.products.id, r.productId));
    return true;
  });
}

export async function release(orderId: string) {
  const d = await db();
  await d
    .update(schema.reservations)
    .set({ status: "released" })
    .where(and(eq(schema.reservations.orderId, orderId), eq(schema.reservations.status, "active")));
}
