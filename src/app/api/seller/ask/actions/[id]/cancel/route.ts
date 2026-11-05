import { cancelAskAction } from "@/lib/ask/agent";
import { requireSeller } from "@/lib/auth/seller";
import { getDemoStore } from "@/lib/store";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireSeller(request);
  if (denied) return denied;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "not found" }, { status: 404 });
  const store = await getDemoStore();
  return (await cancelAskAction(id, store.id)) ? Response.json({ ok: true }) : Response.json({ error: "not pending" }, { status: 409 });
}
