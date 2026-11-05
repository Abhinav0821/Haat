import { buildDailyBrief } from "@/lib/brief";
import { getDemoStore } from "@/lib/store";

/** Today's summary for the seller, in Hindi and English. */
export async function GET() {
  const store = await getDemoStore();
  return Response.json(await buildDailyBrief(store.id));
}
