import { getAutopilotBoard } from "@/lib/autopilot/refunds";
import { getDemoStore } from "@/lib/store";

/** Proposals awaiting the seller, orders to ship, and what the autopilot did. */
export async function GET() {
  const store = await getDemoStore();
  return Response.json(await getAutopilotBoard(store.id));
}
