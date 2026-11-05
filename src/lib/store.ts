import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { DEMO_STORE } from "./store-constants";

export { DEMO_STORE, MAKER_PROFILES, sellerLanguage } from "./store-constants";

export async function getDemoStore() {
  const d = await db();
  const [existing] = await d.select().from(schema.stores).where(eq(schema.stores.slug, DEMO_STORE.slug));
  if (existing) return existing;
  await d.insert(schema.stores).values({ ...DEMO_STORE }).onConflictDoNothing();
  const [created] = await d.select().from(schema.stores).where(eq(schema.stores.slug, DEMO_STORE.slug));
  return created;
}
