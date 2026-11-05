import { requireSeller } from "@/lib/auth/seller";
import { buildDailyBrief } from "@/lib/brief";
import { getDemoStore } from "@/lib/store";

/** Today's summary for the seller, in Hindi and English. */
export async function GET(request: Request) {
  const denied = await requireSeller(request);
  if (denied) return denied;
  const store = await getDemoStore();
  return Response.json(await buildDailyBrief(store.id));
}
