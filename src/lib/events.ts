import { db, schema } from "@/db";

/** Record a pilot-study event. Never throws — measurement must not break the product. */
export async function logEvent(name: string, props: Record<string, unknown> = {}, storeId: string | null = null) {
  try {
    const d = await db();
    await d.insert(schema.events).values({ name, props, storeId });
  } catch (e) {
    console.warn("[events] not recorded:", (e as Error).message);
  }
}
