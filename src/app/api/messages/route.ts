import { z } from "zod";
import { getBuyerThread, MessageError, postBuyerMessage, toBuyerView } from "@/lib/messages";

/**
 * Buyer-side messaging. Accepts JSON, or multipart with up to 3 photos
 * (payment screenshots, damage photos). Scam Shield verdicts are never
 * returned to the buyer.
 */

const Fields = z
  .object({
    orderId: z.string().uuid().optional(),
    productId: z.string().uuid().optional(),
    text: z.string().min(2).max(2000),
    email: z.string().email().max(254).optional(),
  })
  .refine((v) => v.orderId || v.productId, "orderId or productId required");

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_PHOTOS = 3;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export async function POST(request: Request) {
  let raw: unknown;
  let images: { data: Uint8Array; mediaType: string }[] = [];

  if ((request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    const form = await request.formData().catch(() => null);
    if (!form) return Response.json({ error: "invalid form" }, { status: 400 });
    const str = (k: string) => (typeof form.get(k) === "string" && form.get(k) ? String(form.get(k)) : undefined);
    raw = { orderId: str("orderId"), productId: str("productId"), text: str("text"), email: str("email") };
    const files = form.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length > MAX_PHOTOS) return Response.json({ error: `at most ${MAX_PHOTOS} photos` }, { status: 400 });
    for (const f of files) {
      if (!IMAGE_TYPES.has(f.type) || f.size > MAX_PHOTO_BYTES) {
        return Response.json({ error: "photos must be JPEG/PNG/WebP under 5 MB" }, { status: 400 });
      }
    }
    images = await Promise.all(files.map(async (f) => ({ data: new Uint8Array(await f.arrayBuffer()), mediaType: f.type })));
  } else {
    raw = await request.json().catch(() => null);
  }

  const parsed = Fields.safeParse(raw);
  if (!parsed.success) return Response.json({ error: "invalid message" }, { status: 400 });
  try {
    const { message, storeSlug } = await postBuyerMessage({ ...parsed.data, buyerEmail: parsed.data.email, channel: "web", images });
    return Response.json(
      { message: toBuyerView(message), threadUrl: message.orderId ? null : `/s/${storeSlug}/q/${message.id}` },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof MessageError) return Response.json({ error: e.message }, { status: e.status });
    console.error("[messages] post failed:", e);
    return Response.json({ error: "Could not send your message" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const orderId = url.searchParams.get("orderId") ?? undefined;
  const rootId = url.searchParams.get("thread") ?? undefined;
  const uuid = /^[0-9a-f-]{36}$/i;
  if ((orderId && !uuid.test(orderId)) || (rootId && !uuid.test(rootId)) || (!orderId && !rootId)) {
    return Response.json({ error: "orderId or thread required" }, { status: 400 });
  }
  return Response.json({ messages: await getBuyerThread({ orderId, rootId }) });
}
