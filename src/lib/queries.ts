import { and, desc, eq } from "drizzle-orm";
import { connection } from "next/server";
import { db, schema } from "@/db";

/**
 * Read-side queries for storefront pages. Each calls connection() so Next.js
 * runs them per request (live stock and order status), never at prerender.
 */

export async function getStore(slug: string) {
  await connection();
  const d = await db();
  const [store] = await d.select().from(schema.stores).where(eq(schema.stores.slug, slug));
  return store ?? null;
}

export async function listLiveProducts(storeId: string) {
  await connection();
  const d = await db();
  return d
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.storeId, storeId), eq(schema.products.status, "live")))
    .orderBy(desc(schema.products.createdAt));
}

export async function getLiveProduct(slug: string, productId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(productId)) return null;
  await connection();
  const d = await db();
  const [row] = await d
    .select({ product: schema.products, store: schema.stores })
    .from(schema.products)
    .innerJoin(schema.stores, eq(schema.stores.id, schema.products.storeId))
    .where(and(eq(schema.products.id, productId), eq(schema.stores.slug, slug), eq(schema.products.status, "live")));
  return row ?? null;
}

export async function getOrderWithStore(slug: string, orderId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) return null;
  await connection();
  const d = await db();
  const [row] = await d
    .select({ order: schema.orders, store: schema.stores })
    .from(schema.orders)
    .innerJoin(schema.stores, eq(schema.stores.id, schema.orders.storeId))
    .where(and(eq(schema.orders.id, orderId), eq(schema.stores.slug, slug)));
  return row ?? null;
}

export const formatUsd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
