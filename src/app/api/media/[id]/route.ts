import { eq } from "drizzle-orm";
import { db, schema } from "@/db";

/** Serves stored photos / voice notes. Media is immutable, so cache aggressively. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("not found", { status: 404 });

  const d = await db();
  const [row] = await d.select().from(schema.media).where(eq(schema.media.id, id));
  if (!row) return new Response("not found", { status: 404 });

  return new Response(Buffer.from(row.bytes), {
    headers: {
      "Content-Type": row.mediaType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
