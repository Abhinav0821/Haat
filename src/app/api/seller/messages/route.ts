import { requireSeller } from "@/lib/auth/seller";
import { getSellerInbox } from "@/lib/messages";
import { getDemoStore } from "@/lib/store";

/** Seller inbox (demo store). Seller auth lands with the passcode step before deploy. */
export async function GET(request: Request) {
  const denied = await requireSeller(request);
  if (denied) return denied;
  const store = await getDemoStore();
  return Response.json({ messages: await getSellerInbox(store.id), store: { name: store.name, owner: store.ownerName } });
}
