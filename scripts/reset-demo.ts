/**
 * Clear test activity (orders, messages, autopilot actions, webhook events) so
 * the demo shop starts clean. Keeps the store, live products and their media.
 * Only touches OUR database — PayPal sandbox records are unaffected.
 *
 *   npm run demo:reset          (stop `npm run dev` first; PGlite allows one process)
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq, inArray, ne, notInArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { DEMO_COLLECTIVE_SLUG } from "@/lib/collective/seed";
import { SettingsSchema } from "@/lib/collective/facts";

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
  await d.delete(schema.reservations);
  await d.delete(schema.rateHits);
  // Pilot sessions: keep each session's events before clearing (npm run pilot:report -- --from <file>).
  const logged = await d.select().from(schema.events);
  if (logged.length) {
    const dir = path.join(process.cwd(), ".data", "pilot-archive");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `events-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify(logged, null, 1));
    console.log(`pilot events archived: ${path.relative(process.cwd(), file)} (${logged.length})`);
  }
  await d.delete(schema.events);
  await d.update(schema.products).set({ soldQuantity: 0 });
  // Collective orders: payouts, parts and plans reference orders; the collective and its makers (and their links) are kept.
  await d.delete(schema.makerPayments); // payments → shares → plans/parts
  await d.delete(schema.makerShares);
  await d.delete(schema.memberParts);
  await d.delete(schema.collectivePlans);
  const collectiveOrders = await d.delete(schema.collectiveOrders).returning({ id: schema.collectiveOrders.id });
  // The demo collective re-asks makers to confirm after `staleAfterDays`; keep confirmations current through judging.
  const [demo] = await d.select().from(schema.collectives).where(eq(schema.collectives.slug, DEMO_COLLECTIVE_SLUG));
  if (demo) {
    const settings = SettingsSchema.parse(demo.settings);
    if (settings.staleAfterDays < 60) {
      await d.update(schema.collectives).set({ settings: { ...settings, staleAfterDays: 60 } as unknown as Record<string, unknown> }).where(eq(schema.collectives.id, demo.id));
      console.log(`demo collective: makers' confirmations now stay current for 60 days (was ${settings.staleAfterDays})`);
    }
  }
  await d.delete(schema.agreements); // references custom requests; orders reference agreements by id only
  const custom = await d.delete(schema.customRequests).returning({ id: schema.customRequests.id });
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
    `removed: ${orders.length} orders, ${custom.length} custom requests, ${collectiveOrders.length} collective orders, ${messages.length} messages, ${actions.length} autopilot actions, ` +
      `${events.length} webhook events, ${archived.length} archived products, ${media.length} unused media files`,
  );
  console.log(`kept: ${live.length} live product(s), ${remaining.length} media file(s)`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message.includes("lock") ? "Database is busy — stop `npm run dev` first." : e);
  process.exit(1);
});
