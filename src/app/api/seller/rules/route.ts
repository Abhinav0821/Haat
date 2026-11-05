import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireSeller } from "@/lib/auth/seller";
import { EconomicsSchema, readEconomics } from "@/lib/economics";
import { env } from "@/lib/env";
import { rulesReadbackHi } from "@/lib/ai/rules";
import { getDemoStore } from "@/lib/store";
import { logEvent } from "@/lib/events";

/** GET the maker's approved rules; PUT saves rules she has reviewed and approved. */
export async function GET(request: Request) {
  const denied = await requireSeller(request);
  if (denied) return denied;
  const store = await getDemoStore();
  const economics = readEconomics(store.policy);
  return Response.json({ economics, readback: economics ? rulesReadbackHi(economics) : null, inrPerUsd: env().INR_PER_USD });
}

export async function PUT(request: Request) {
  const denied = await requireSeller(request);
  if (denied) return denied;
  const parsed = EconomicsSchema.safeParse((await request.json().catch(() => null))?.economics);
  if (!parsed.success) return Response.json({ error: "invalid rules", issues: parsed.error.issues }, { status: 400 });
  const store = await getDemoStore();
  const d = await db();
  await d
    .update(schema.stores)
    .set({ policy: { ...(store.policy as Record<string, unknown>), economics: parsed.data, economicsApprovedAt: new Date().toISOString() } })
    .where(eq(schema.stores.id, store.id));
  await logEvent("rules_approved", { missing: rulesReadbackHi(parsed.data).missing.length }, store.id);
  return Response.json({ ok: true, economics: parsed.data, readback: rulesReadbackHi(parsed.data) });
}
