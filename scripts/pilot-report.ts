/**
 * Summarise pilot-study events.
 *
 *   npm run pilot:report                       current database (stop `npm run dev` first when using the embedded DB)
 *   npm run pilot:report -- --from <file.json> an archive written by `npm run demo:reset` (one per participant session)
 *
 * Only counts what the app logged; per-task success, assistance and quotes come from the facilitator's sheet
 * (the session protocol is kept outside the repository).
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { readFileSync } from "node:fs";
import { pilotSummary, type Ev } from "@/lib/pilot";

async function main() {
  const i = process.argv.indexOf("--from");
  let rows: Ev[];
  if (i > 0 && process.argv[i + 1]) {
    rows = JSON.parse(readFileSync(process.argv[i + 1], "utf8")) as Ev[];
    console.log(`archive: ${process.argv[i + 1]} (${rows.length} events)`);
  } else {
    const { db, schema, closeDb } = await import("@/db");
    rows = (await (await db()).select().from(schema.events)) as Ev[];
    await closeDb();
  }
  for (const l of pilotSummary(rows)) console.log(l);
  process.exit(0);
}

if (process.argv[1]?.includes("pilot-report")) void main();
