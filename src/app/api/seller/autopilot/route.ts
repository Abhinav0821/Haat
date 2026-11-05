import { requireSeller } from "@/lib/auth/seller";
import { getAutopilotBoard } from "@/lib/autopilot/refunds";
import { getDemoStore } from "@/lib/store";

/** Proposals awaiting the seller, orders to ship, and what the autopilot did. */
export async function GET(request: Request) {
  const denied = await requireSeller(request);
  if (denied) return denied;
  const store = await getDemoStore();
  return Response.json(await getAutopilotBoard(store.id));
}
