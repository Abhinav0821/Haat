/**
 * Clear test activity (orders, messages, autopilot actions, webhook events) so
 * the demo shop starts clean. Keeps the store, live products and their media.
 * Only touches OUR database — PayPal sandbox records are unaffected.
 *
 *   npm run demo:reset          (stop `npm run dev` first; PGlite allows one process)
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { cpSync, existsSync } from "node:fs";
import path from "node:path";
import { inArray, ne, notInArray } from "drizzle-orm";
import { db, schema } from "@/db";

async function main() {
  if (!process.env.DATABASE_URL) {
    const dir = path.join(process.cwd(), ".data", "pglite");
    if (existsSync(dir)) {
      const backup = `${dir}-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      cpSync(dir, backup, { recursive: true });
      console.log(`backup: ${path.relative(process.cwd(), backup)}`);
    }
  }

  const d = await db();
  const actions = await d.delete(schema.agentActions).returning({ id: schema.agentActions.id });
  const messages = await d.delete(schema.messages).returning({ id: schema.messages.id });
  const events = await d.delete(schema.webhookEvents).returning({ id: schema.webhookEvents.id });
  const orders = await d.delete(schema.orders).returning({ id: schema.orders.id });
  const notLive = await d.select({ id: schema.products.id }).from(schema.products).where(ne(schema.products.status, "live"));
  if (notLive.length) await d.delete(schema.passports).where(inArray(schema.passports.productId, notLive.map((p) => p.id)));
  const archived = await d.delete(schema.products).where(ne(schema.products.status, "live")).returning({ id: schema.products.id });

  // Keep media used by live products; drop drafts that were never published.
  const live = await d.select({ images: schema.products.images, voice: schema.products.voiceNoteId }).from(schema.products);
  const keep = live.flatMap((p) => [...p.images, ...(p.voice ? [p.voice] : [])]);
  const media = keep.length
    ? await d.delete(schema.media).where(notInArray(schema.media.id, keep)).returning({ id: schema.media.id })
    : await d.delete(schema.media).returning({ id: schema.media.id });
  const remaining = keep.length ? await d.select({ id: schema.media.id }).from(schema.media).where(inArray(schema.media.id, keep)) : [];

  console.log(
    `removed: ${orders.length} orders, ${messages.length} messages, ${actions.length} autopilot actions, ` +
      `${events.length} webhook events, ${archived.length} archived products, ${media.length} unused media files`,
  );
  console.log(`kept: ${live.length} live product(s), ${remaining.length} media file(s)`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message.includes("lock") ? "Database is busy — stop `npm run dev` first." : e);
  process.exit(1);
});
