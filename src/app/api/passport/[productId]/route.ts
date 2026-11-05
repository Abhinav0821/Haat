import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { verifyPayload } from "@/lib/passport/signing";

/**
 * Public, machine-readable Handmade Passport. The signature is checked on every
 * request; verify it yourself with /api/passport/public-key (Ed25519 over the
 * canonical JSON of `payload`, keys sorted).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ productId: string }> }) {
  const { productId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(productId)) return Response.json({ error: "not found" }, { status: 404 });
  const d = await db();
  const [p] = await d.select().from(schema.passports).where(eq(schema.passports.productId, productId));
  if (!p || p.status !== "verified" || !p.payload || !p.signature) {
    return Response.json({ verifiedHandmade: false }, { status: 404 });
  }
  return Response.json({
    verifiedHandmade: true,
    signatureValid: verifyPayload(p.payload, p.signature),
    algorithm: "Ed25519",
    payload: p.payload,
    signature: p.signature,
    publicKey: "/api/passport/public-key",
  });
}
