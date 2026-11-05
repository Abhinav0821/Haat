import { AutopilotError, rejectProposal } from "@/lib/autopilot/refunds";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await rejectProposal(id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof AutopilotError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
