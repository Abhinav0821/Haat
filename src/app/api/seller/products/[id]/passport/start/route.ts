import { requireSeller } from "@/lib/auth/seller";
import { PassportError, startPassport } from "@/lib/passport/passport";
import { getDemoStore } from "@/lib/store";

/** Issue a fresh handwritten code for the proof photo. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireSeller(request);
  if (denied) return denied;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "not found" }, { status: 404 });
  try {
    const store = await getDemoStore();
    return Response.json(await startPassport(id, store.id));
  } catch (e) {
    if (e instanceof PassportError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
