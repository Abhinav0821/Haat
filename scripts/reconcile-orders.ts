/**
 * Manual recovery for payments whose outcome never reached Haat (lost capture
 * response AND webhooks exhausted). Asks PayPal for its own record of each order
 * and records it through the same finaliser every capture path uses — so a
 * completed capture becomes COMPLETED with its capture id, time, fees and buyer
 * details; a pending capture stays pending; anything ambiguous is left alone.
 *
 *   npm run reconcile -- <paypalOrderId> [<paypalOrderId> …]
 *   npm run reconcile -- --stale      every APPROVED order older than 15 minutes
 *
 * Stop `npm run dev` first when using the embedded database.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { and, eq, inArray, lt } from "drizzle-orm";
import { closeDb, db, schema } from "@/db";
import { paypal } from "@/lib/paypal/client";
import { finalizePayment, type PayPalOrderSnapshot } from "@/lib/paypal/finalize";

async function main() {
  const args = process.argv.slice(2);
  const d = await db();
  const rows = args.includes("--stale")
    ? await d
        .select()
        .from(schema.orders)
        .where(and(eq(schema.orders.status, "APPROVED"), lt(schema.orders.updatedAt, new Date(Date.now() - 15 * 60_000))))
    : args.length
      ? await d.select().from(schema.orders).where(inArray(schema.orders.paypalOrderId, args))
      : [];
  if (!rows.length) console.log(args.length ? "no matching orders" : "usage: npm run reconcile -- <paypalOrderId…> | --stale");
  for (const o of rows) {
    try {
      const pp = await paypal<PayPalOrderSnapshot>(`/v2/checkout/orders/${encodeURIComponent(o.paypalOrderId)}`);
      const r = await finalizePayment(o.id, pp);
      console.log(`${o.paypalOrderId}: PayPal ${pp.status ?? "?"} → capture ${r.outcome} → order ${r.status}${r.outcome === "UNKNOWN" ? " (left unchanged)" : ""}`);
    } catch (e) {
      console.log(`${o.paypalOrderId}: failed — ${(e as Error).message.slice(0, 160)}`);
    }
  }
  await closeDb();
  process.exit(0);
}
main();
