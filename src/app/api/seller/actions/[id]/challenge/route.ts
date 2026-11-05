import { AutopilotError, createChallenge } from "@/lib/autopilot/refunds";

/** Issue a fresh spoken code word for approving this refund. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return Response.json(await createChallenge(id));
  } catch (e) {
    if (e instanceof AutopilotError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
