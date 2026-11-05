import { confirmAskAction } from "@/lib/ask/agent";
import { requireSeller } from "@/lib/auth/seller";
import { getDemoStore } from "@/lib/store";

/** Seller confirmed a drafted invoice or reply. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireSeller(request);
  if (denied) return denied;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "not found" }, { status: 404 });
  const store = await getDemoStore();
  const r = await confirmAskAction(id, store.id);
  return "error" in r ? Response.json(r, { status: 409 }) : Response.json(r);
}
