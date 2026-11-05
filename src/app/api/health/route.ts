import { sql } from "drizzle-orm";
import { connection } from "next/server";
import { db } from "@/db";

/** Liveness + database check for the hosting platform. */
export async function GET() {
  await connection();
  try {
    const d = await db();
    await d.execute(sql`select 1`);
    return Response.json({ ok: true, db: "ok" });
  } catch (e) {
    return Response.json({ ok: false, db: (e as Error).message.slice(0, 120) }, { status: 503 });
  }
}
