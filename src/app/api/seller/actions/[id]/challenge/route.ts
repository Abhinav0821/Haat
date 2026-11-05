import { requireSeller } from "@/lib/auth/seller";
import { AutopilotError, createChallenge } from "@/lib/autopilot/refunds";

/** Issue a fresh spoken code word for approving this refund. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireSeller(request);
  if (denied) return denied;
  const { id } = await params;
  try {
    return Response.json(await createChallenge(id));
  } catch (e) {
    if (e instanceof AutopilotError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
