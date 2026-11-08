import { sql } from "drizzle-orm";
import { connection } from "next/server";
import { db } from "@/db";
import journal from "../../../../drizzle/meta/_journal.json";

/**
 * Liveness + database check for the hosting platform. Also says which commit is deployed
 * (Vercel's own VERCEL_GIT_COMMIT_SHA) and whether every migration in this build has been
 * applied, so a deploy can be verified from outside without dashboard access.
 */
export async function GET() {
  await connection();
  const expected = journal.entries.length;
  const latest = journal.entries[expected - 1]?.tag ?? null;
  const commit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null;
  try {
    const d = await db();
    await d.execute(sql`select 1`);
    const rows = (await d.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)) as unknown as { rows?: { n: number }[] } | { n: number }[];
    const applied = Number((Array.isArray(rows) ? rows[0]?.n : rows.rows?.[0]?.n) ?? 0);
    return Response.json({ ok: applied === expected, db: "ok", commit, migrations: { applied, expected, latest } }, { status: applied === expected ? 200 : 503 });
  } catch (e) {
    return Response.json({ ok: false, db: (e as Error).message.slice(0, 120), commit, migrations: { applied: null, expected, latest } }, { status: 503 });
  }
}
