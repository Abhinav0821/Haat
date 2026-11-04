import path from "node:path";
import { mkdirSync } from "node:fs";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

/** Driver-agnostic handle: both PGlite and postgres-js are PgDatabase underneath. */
export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Database handle.
 *  - DATABASE_URL set  → real Postgres (production / Render)
 *  - DATABASE_URL empty → embedded Postgres (PGlite) in ./.data — zero setup
 *    so judges can run `npm install && npm run dev`.
 */

const MIGRATIONS = path.join(process.cwd(), "drizzle");

async function create(): Promise<DB> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const postgres = (await import("postgres")).default;
    const db = drizzle(postgres(url, { max: 5 }), { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    return db as unknown as DB;
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  // PGLITE_DIR=memory:// gives tests a throwaway in-memory database.
  const dir = process.env.PGLITE_DIR ?? path.join(process.cwd(), ".data", "pglite");
  if (!dir.startsWith("memory://")) mkdirSync(dir, { recursive: true });
  const db = drizzle(new PGlite(dir), { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return db as unknown as DB;
}

// Reuse one connection across Next.js hot reloads.
const g = globalThis as unknown as { __haatDb?: Promise<DB> };

export function db(): Promise<DB> {
  g.__haatDb ??= create();
  return g.__haatDb;
}

export { schema };
