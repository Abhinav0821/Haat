import path from "node:path";
import { mkdirSync } from "node:fs";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

/** Driver-agnostic handle: both PGlite and postgres-js are PgDatabase underneath. */
export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Database handle.
 *  - DATABASE_URL set  → real Postgres (production: Neon via Vercel, or any Postgres)
 *  - DATABASE_URL empty → embedded Postgres (PGlite) in ./.data — zero setup
 *    so judges can run `npm install && npm run dev`.
 */

const MIGRATIONS = path.join(process.cwd(), "drizzle");

let closer: (() => Promise<void>) | null = null;

/**
 * Migrations run at startup locally. On Vercel (serverless) they run ONCE in the
 * build step (scripts/migrate.ts) instead: many cold starts migrating at the same
 * time could race. Set RUN_MIGRATIONS=1 to force them at startup anyway.
 */
const migrateAtStartup = () => process.env.RUN_MIGRATIONS === "1" || !process.env.VERCEL;

async function create(): Promise<DB> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const postgres = (await import("postgres")).default;
    // prepare:false — required behind transaction-mode poolers (Neon's "-pooler" host, PgBouncer).
    const client = postgres(url, { max: Number(process.env.DB_POOL_MAX ?? 5), prepare: false, idle_timeout: 20 });
    closer = () => client.end({ timeout: 5 });
    const db = drizzle(client, { schema });
    if (migrateAtStartup()) await migrate(db, { migrationsFolder: MIGRATIONS });
    return db as unknown as DB;
  }
  if (process.env.VERCEL) {
    // Serverless file systems are read-only and per-instance: the embedded database can't work there.
    throw new Error("DATABASE_URL is not set. On Vercel, connect a Postgres database (e.g. Neon) — see DEPLOY.md.");
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  // PGLITE_DIR=memory:// gives tests a throwaway in-memory database.
  const dir = process.env.PGLITE_DIR ?? path.join(process.cwd(), ".data", "pglite");
  if (!dir.startsWith("memory://")) mkdirSync(dir, { recursive: true });
  const pg = new PGlite(dir);
  closer = () => pg.close();
  const db = drizzle(pg, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return db as unknown as DB;
}

/** Apply migrations explicitly (build step / scripts). */
export async function runMigrations() {
  const d = await db();
  if (process.env.DATABASE_URL && !migrateAtStartup()) {
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await migrate(d as never, { migrationsFolder: MIGRATIONS });
  }
}

/** Close the connection (scripts and tests; a pooled client would otherwise keep Node alive). */
export async function closeDb() {
  if (!g.__haatDb) return;
  await g.__haatDb.catch(() => undefined);
  await closer?.();
  g.__haatDb = undefined;
  closer = null;
}

// Reuse one connection across Next.js hot reloads.
const g = globalThis as unknown as { __haatDb?: Promise<DB> };

export function db(): Promise<DB> {
  g.__haatDb ??= create();
  return g.__haatDb;
}

export { schema };

// ── Transactions ────────────────────────────────────────────────────────────
// PGlite runs every query over ONE connection, so two concurrent transactions
// would interleave their statements. Serialise them in-process. (Real Postgres
// gives each transaction its own connection and row locks do the work.)
let txQueue: Promise<unknown> = Promise.resolve();

export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

export async function withTx<T>(fn: (tx: Tx) => Promise<T>, database?: DB): Promise<T> {
  const d = database ?? (await db());
  if (process.env.DATABASE_URL) return d.transaction(fn);
  const run = txQueue.then(() => d.transaction(fn));
  txQueue = run.catch(() => undefined);
  return run;
}
