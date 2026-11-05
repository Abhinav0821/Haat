import { connection } from "next/server";
import { publicKeyPem } from "@/lib/passport/signing";

/** Ed25519 public key (PEM) for verifying Maker Evidence records. */
export async function GET() {
  await connection(); // derived from runtime secrets — never prerender
  return new Response(publicKeyPem(), { headers: { "Content-Type": "application/x-pem-file", "Cache-Control": "public, max-age=3600" } });
}
