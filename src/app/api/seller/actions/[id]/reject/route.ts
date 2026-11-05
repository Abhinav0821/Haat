import { requireSeller } from "@/lib/auth/seller";
import { AutopilotError, rejectProposal } from "@/lib/autopilot/refunds";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireSeller(request);
  if (denied) return denied;
  const { id } = await params;
  try {
    await rejectProposal(id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof AutopilotError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
