import { requireSeller } from "@/lib/auth/seller";
import { PassportError, submitProof } from "@/lib/passport/passport";
import { getDemoStore } from "@/lib/store";

/** Upload the proof photo (piece + handwritten code) and run the checks. */
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireSeller(request);
  if (denied) return denied;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "not found" }, { status: 404 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("photo");
  if (!(file instanceof File) || !IMAGE_TYPES.has(file.type) || file.size > 6 * 1024 * 1024) {
    return Response.json({ error: "please upload a photo (JPEG/PNG, under 6 MB)" }, { status: 400 });
  }
  try {
    const store = await getDemoStore();
    const passport = await submitProof(id, store.id, { data: new Uint8Array(await file.arrayBuffer()), mediaType: file.type });
    return Response.json({ status: passport.status, checks: passport.checks, verifiedAt: passport.verifiedAt });
  } catch (e) {
    if (e instanceof PassportError) return Response.json({ error: e.message }, { status: e.status });
    console.error("[passport] proof failed:", e);
    return Response.json({ error: "Couldn't check the photo right now — please try again in a minute." }, { status: 503 });
  }
}
