import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { DEMO_COLLECTIVE_SLUG, seedCollective } from "./seed";

/** The demo collective; created on first use (makers' links are issued by the coordinator, shown once). */
export async function getDemoCollective() {
  const d = await db();
  const find = async () => (await d.select().from(schema.collectives).where(eq(schema.collectives.slug, DEMO_COLLECTIVE_SLUG)))[0];
  const existing = await find();
  if (existing) return existing;
  try {
    return (await seedCollective(d)).collective;
  } catch (e) {
    const raced = await find();
    if (raced) return raced;
    throw e;
  }
}

export async function membersOf(collectiveId: string) {
  const d = await db();
  return d.select().from(schema.members).where(eq(schema.members.collectiveId, collectiveId)).orderBy(asc(schema.members.createdAt), asc(schema.members.id));
}
