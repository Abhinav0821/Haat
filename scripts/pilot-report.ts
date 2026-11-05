/**
 * Summarise pilot-study events.  npm run pilot:report   (stop `npm run dev` first when using the embedded DB)
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { db, schema } from "@/db";

async function main() {
  const d = await db();
  const rows = await d.select().from(schema.events);
  const published = rows.filter((r) => r.name === "listing_published");
  const durations = published.map((r) => r.props.durationMs as number | null).filter((n): n is number => typeof n === "number").sort((a, b) => a - b);
  const median = durations.length ? durations[Math.floor(durations.length / 2)] : null;
  console.log(`listings published: ${published.length}`);
  console.log(`time to list (median): ${median !== null ? `${Math.round(median / 1000)} s` : "n/a"}  [${durations.map((d) => Math.round(d / 1000) + "s").join(", ")}]`);
  console.log(`voice corrections used: ${rows.filter((r) => r.name === "listing_corrected_by_voice").length}`);
  console.log(`rules approved: ${rows.filter((r) => r.name === "rules_approved").length}`);
  process.exit(0);
}
main();
