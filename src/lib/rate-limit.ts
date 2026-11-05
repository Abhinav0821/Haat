import { and, count, eq, gte, lt } from "drizzle-orm";
import { db, schema } from "@/db";

/**
 * Sliding-window rate limits stored in the database, so they hold across
 * serverless instances and restarts (an in-memory Map would reset per instance).
 */

/** Record one hit and say whether it is within `max` per `windowMs`. */
export async function hit(key: string, max: number, windowMs: number, now = new Date()): Promise<boolean> {
  await record(key, now);
  return (await recentHits(key, windowMs, now)) <= max;
}

/** Check without recording (e.g. before a login attempt; failures are recorded separately). */
export async function allowed(key: string, max: number, windowMs: number, now = new Date()): Promise<boolean> {
  return (await recentHits(key, windowMs, now)) < max;
}

export async function record(key: string, now = new Date()) {
  const d = await db();
  await d.insert(schema.rateHits).values({ key, at: now });
  // Keep the table small: drop this key's hits older than a day.
  await d.delete(schema.rateHits).where(and(eq(schema.rateHits.key, key), lt(schema.rateHits.at, new Date(now.getTime() - 86_400_000))));
}

async function recentHits(key: string, windowMs: number, now: Date): Promise<number> {
  const d = await db();
  const [r] = await d
    .select({ n: count() })
    .from(schema.rateHits)
    .where(and(eq(schema.rateHits.key, key), gte(schema.rateHits.at, new Date(now.getTime() - windowMs))));
  return Number(r?.n ?? 0);
}
