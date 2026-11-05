import { z } from "zod";
import { getBuyerThread, MessageError, postBuyerMessage, toBuyerView } from "@/lib/messages";

/** Buyer-side messaging. Scam Shield verdicts are never returned to the buyer. */

const Post = z
  .object({
    orderId: z.string().uuid().optional(),
    productId: z.string().uuid().optional(),
    text: z.string().min(2).max(2000),
    email: z.string().email().max(254).optional(),
  })
  .refine((v) => v.orderId || v.productId, "orderId or productId required");

export async function POST(request: Request) {
  const parsed = Post.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid message" }, { status: 400 });
  try {
    const { message, storeSlug } = await postBuyerMessage({ ...parsed.data, buyerEmail: parsed.data.email, channel: "web" });
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
