import { requireSeller } from "@/lib/auth/seller";
import { listRequests } from "@/lib/custom/requests";
import { getDemoStore } from "@/lib/store";

export async function GET(request: Request) {
  const denied = await requireSeller(request);
  if (denied) return denied;
  const store = await getDemoStore();
  return Response.json({ requests: await listRequests(store.id) });
}
