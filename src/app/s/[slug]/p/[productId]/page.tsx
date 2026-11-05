import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ProductArt, SiteFooter, SiteHeader } from "@/components/craft";
import { MessageThread } from "@/components/message-thread";
import { VoiceButton } from "@/components/voice-button";
import { env } from "@/lib/env";
import { formatUsd, getLiveProduct } from "@/lib/queries";
import { MAKER_PROFILES } from "@/lib/store";
import { PayPalCheckout } from "./paypal-checkout";

export async function generateMetadata(props: PageProps<"/s/[slug]/p/[productId]">): Promise<Metadata> {
  const { slug, productId } = await props.params;
  const row = await getLiveProduct(slug, productId);
  if (!row) return { title: "Not found · Haat" };
  const { product, store } = row;
  return {
    title: `${product.title} · ${store.name}`,
    description: product.description.slice(0, 160),
    openGraph: {
      title: product.title,
      description: `Handmade by ${store.ownerName}. ${formatUsd(product.priceCents)} · Pay with PayPal.`,
      images: product.images[0] ? [`/api/media/${product.images[0]}`] : [],
    },
  };
}

export default function ProductPage(props: PageProps<"/s/[slug]/p/[productId]">) {
  return (
    <Suspense fallback={<SiteHeader />}>
      <Product params={props.params} />
    </Suspense>
  );
}

type Attrs = {
  materials?: string[];
  colors?: string[];
  dimensions?: string | null;
  origin?: string | null;
  handmade?: boolean | null;
  care?: string | null;
};

async function Product({ params }: { params: PageProps<"/s/[slug]/p/[productId]">["params"] }) {
  const { slug, productId } = await params;
  const row = await getLiveProduct(slug, productId);
  if (!row) notFound();
  const { product: p, store } = row;
  const attrs = p.attributes as Attrs;
  const profile = MAKER_PROFILES[store.slug];
  const details: [string, string | null | undefined][] = [
    ["Material", attrs.materials?.join(", ")],
    ["Colour", attrs.colors?.join(", ")],
    ["Size", attrs.dimensions],
    ["Origin", attrs.origin],
    ["Care", attrs.care],
  ];
  const { PAYPAL_CLIENT_ID, PAYPAL_ENV } = env();

  return (
    <>
      <SiteHeader storeSlug={store.slug} storeName={store.name} />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 pt-10">
        <div className="grid gap-12 lg:grid-cols-[1.15fr_1fr] lg:gap-20">
          {/* Images */}
          <div className="space-y-4 lg:sticky lg:top-10 lg:self-start">
            {p.images.length ? (
              p.images.map((id, i) => (
                <img key={id} src={`/api/media/${id}`} alt={i === 0 ? p.title : ""} className="w-full bg-paper-deep object-cover" />
              ))
            ) : (
              <ProductArt className="aspect-[4/5] w-full" />
            )}
          </div>

          {/* Details */}
          <div className="lg:pt-6">
            <Link href={`/s/${store.slug}`} className="eyebrow hover:text-ink">
              {store.name}
            </Link>
            <h1 className="mt-4 font-display text-4xl font-normal leading-tight sm:text-5xl">{p.title}</h1>
            <p className="mt-4 text-lg">{formatUsd(p.priceCents)}</p>
            {attrs.handmade && <p className="eyebrow mt-2">Handmade · One of a kind</p>}

            <div className="mt-10">
              <PayPalCheckout
                productId={p.id}
                storeSlug={store.slug}
                clientId={PAYPAL_CLIENT_ID}
                sdkUrl={
                  PAYPAL_ENV === "live" ? "https://www.paypal.com/web-sdk/v6/core" : "https://www.sandbox.paypal.com/web-sdk/v6/core"
                }
              />
              <p className="mt-4 text-xs leading-relaxed text-muted">
                Secure checkout with PayPal Buyer Protection. Ships from India, with tracking, to the address in your PayPal account.
              </p>
            </div>

            <p className="mt-12 leading-relaxed">{p.description}</p>

            <dl className="mt-10 border-t border-line text-sm">
              {details
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k} className="grid grid-cols-[6.5rem_1fr] gap-4 border-b border-line py-4">
                    <dt className="eyebrow pt-0.5">{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
            </dl>

            {(p.voiceNoteId || p.sellerTranscript) && (
              <section className="mt-14 bg-card px-7 py-8">
                <p className="eyebrow">In the maker’s words</p>
                {p.sellerTranscript && (
                  <blockquote className="mt-5 font-display text-2xl leading-snug" lang="hi">
                    “{p.sellerTranscript}”
                  </blockquote>
                )}
                {p.sellerTranslation && <p className="mt-4 text-sm leading-relaxed text-muted">{p.sellerTranslation}</p>}
                <div className="mt-7 flex flex-wrap items-center justify-between gap-4">
                  <p className="text-sm">
                    {store.ownerName}
                    {profile && <span className="text-muted"> · {profile.place}</span>}
                  </p>
                  {p.voiceNoteId && <VoiceButton src={`/api/media/${p.voiceNoteId}`} label="Listen" />}
                </div>
                <p className="mt-6 border-t border-line pt-4 text-xs text-muted">
                  Described by {store.ownerName} in {p.sellerLanguage ?? "her own language"}. The English listing was drafted with AI
                  and approved by her.
                </p>
              </section>
            )}

            <div className="mt-14 border-t border-line pt-10">
              <MessageThread makerName={store.ownerName} productId={p.id} />
            </div>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
