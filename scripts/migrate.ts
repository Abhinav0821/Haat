/**
 * Apply database migrations once, before the app starts serving.
 * Used by the Vercel build (`vercel-build`); harmless to run locally.
 */
import { closeDb, runMigrations } from "@/db";

async function main() {
  await runMigrations();
  await closeDb();
  console.log(`migrations applied (${process.env.DATABASE_URL ? "Postgres" : "embedded PGlite"})`);
}

main().catch((e) => {
  console.error("migration failed:", e);
  process.exit(1);
});
