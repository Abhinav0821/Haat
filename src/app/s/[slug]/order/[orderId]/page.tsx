import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { SiteFooter, SiteHeader } from "@/components/craft";
import { formatUsd, getOrderWithStore } from "@/lib/queries";

export default function OrderPage(props: PageProps<"/s/[slug]/order/[orderId]">) {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-full max-w-lg flex-1 px-6 py-20">
        <Suspense fallback={<p className="text-center text-muted">Loading your order…</p>}>
          <Order params={props.params} />
        </Suspense>
      </main>
      <SiteFooter />
    </>
  );
}

const MESSAGES: Record<string, { title: string; body: string; tone: "ok" | "wait" | "bad" }> = {
  COMPLETED: { title: "Thank you — payment received", body: "The maker has been notified and will ship soon.", tone: "ok" },
  PENDING: { title: "Payment is being processed", body: "PayPal is reviewing this payment. We'll ship once it clears.", tone: "wait" },
  APPROVED: { title: "Finishing your payment…", body: "This usually takes a few seconds.", tone: "wait" },
  CREATED: { title: "Payment not completed", body: "You haven't been charged.", tone: "bad" },
  DENIED: { title: "Payment was declined", body: "You haven't been charged. Please try another payment method.", tone: "bad" },
  REFUNDED: { title: "Refunded", body: "This order was refunded to your PayPal account.", tone: "ok" },
  PARTIALLY_REFUNDED: { title: "Partially refunded", body: "Part of this order was refunded to your PayPal account.", tone: "ok" },
};

async function Order({ params }: { params: PageProps<"/s/[slug]/order/[orderId]">["params"] }) {
  const { slug, orderId } = await params;
  const row = await getOrderWithStore(slug, orderId);
  if (!row) notFound();
  const { order, store } = row;
  const m = MESSAGES[order.status] ?? { title: order.status, body: "", tone: "wait" as const };
  const tone = { ok: "border-leaf text-leaf", wait: "border-marigold text-marigold", bad: "border-danger text-danger" }[m.tone];

  return (
    <div className="text-center">
      <div className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full border text-xl ${tone}`} aria-hidden>
        {m.tone === "ok" ? "✓" : m.tone === "bad" ? "!" : "…"}
      </div>
      <p className="eyebrow mt-8">Order confirmation</p>
      <h1 className="mt-3 font-display text-4xl font-normal leading-tight">{m.title}</h1>
      <p className="mt-3 text-muted">{m.body}</p>
      <dl className="mt-12 border-t border-line text-left text-sm">
        <Row k="Shop" v={store.name} />
        <Row k="Amount" v={formatUsd(order.amountCents)} />
        <Row k="PayPal order" v={order.paypalOrderId} mono />
        {order.shippingAddress && (
          <Row
            k="Ships to"
            v={[order.shippingAddress.name, ...order.shippingAddress.lines, order.shippingAddress.city, order.shippingAddress.countryCode]
              .filter(Boolean)
              .join(", ")}
          />
        )}
      </dl>
      <Link href={`/s/${store.slug}`} className="eyebrow mt-12 inline-block text-ink underline underline-offset-8 hover:text-muted">
        Back to {store.name}
      </Link>
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-6 border-b border-line py-4">
      <dt className="eyebrow pt-0.5">{k}</dt>
      <dd className={`text-right ${mono ? "font-mono text-xs" : ""}`}>{v}</dd>
    </div>
  );
}
