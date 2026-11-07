import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Assurances, ProductArt, SiteFooter, SiteHeader } from "@/components/craft";
import { VoiceButton } from "@/components/voice-button";
import { formatUsd, getStore, listLiveProducts } from "@/lib/queries";
import { getPassportsFor } from "@/lib/passport/passport";
import { availableQuantity } from "@/lib/inventory";
import { MAKER_PROFILES } from "@/lib/store";
import { PAGE } from "@/components/layout";

export async function generateMetadata(props: PageProps<"/s/[slug]">): Promise<Metadata> {
  const { slug } = await props.params;
  const store = await getStore(slug);
  return store
    ? { title: `${store.name} · Haat`, description: `Handmade by ${store.ownerName}, described in her own voice. Pay securely with PayPal.` }
    : { title: "Not found · Haat" };
}

export default function StorePage(props: PageProps<"/s/[slug]">) {
  return (
    <Suspense fallback={<SiteHeader />}>
      <Store params={props.params} />
    </Suspense>
  );
}

async function Store({ params }: { params: PageProps<"/s/[slug]">["params"] }) {
  const { slug } = await params;
  const store = await getStore(slug);
  if (!store) notFound();
  const products = await listLiveProducts(store.id);
  const profile = MAKER_PROFILES[store.slug];
  const voiced = products.find((p) => p.voiceNoteId && p.sellerTranscript);
  const passports = await getPassportsFor(products.map((p) => p.id));
  const stock = new Map(await Promise.all(products.map(async (p) => [p.id, await availableQuantity(p.id)] as const)));

  return (
    <>
      <SiteHeader storeSlug={store.slug} storeName={store.name} />

      <main className={`${PAGE} flex-1`}>
        {/* Masthead */}
        <section className="py-20 text-center sm:py-28">
          <p className="eyebrow">The workshop of {store.ownerName}</p>
          <h1 className="mt-6 font-display text-5xl font-normal leading-[1.05] tracking-tight sm:text-7xl">{store.name}</h1>
          {profile && (
            <>
              <p className="eyebrow mt-6">
                {profile.place} <span className="mx-2 text-line">|</span> {profile.craft}
              </p>
              <p className="mt-5 text-lg font-light text-muted" lang="hi">
                {profile.taglineHi}
              </p>
            </>
          )}
        </section>

        {/* Collection */}
        <section>
          <div className="flex items-baseline justify-between border-b border-line pb-4">
            <h2 className="eyebrow text-ink">The collection</h2>
            <p className="eyebrow">
              {products.length} {products.length === 1 ? "piece" : "pieces"}
            </p>
          </div>

          {products.length === 0 ? (
            <p className="py-24 text-center text-muted">
              Nothing listed yet.{" "}
              <Link href="/seller/list" className="text-ink underline underline-offset-4">
                List the first piece by voice
              </Link>
            </p>
          ) : (
            <ul className="grid grid-cols-2 gap-x-6 gap-y-14 pt-10 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {products.map((p) => {
                const attrs = p.attributes as { materials?: string[] };
                return (
                  <li key={p.id}>
                    <Link href={`/s/${store.slug}/p/${p.id}`} className="group block">
                      <div className="aspect-[4/5] overflow-hidden bg-paper-deep">
                        {p.images[0] ? (
                          <img
                            src={`/api/media/${p.images[0]}`}
                            alt={p.title}
                            className="h-full w-full object-cover transition duration-700 ease-out group-hover:scale-[1.03]"
                          />
                        ) : (
                          <ProductArt className="h-full w-full" />
                        )}
                      </div>
                      <h3 className="mt-5 font-display text-xl leading-snug">{p.title}</h3>
                      {attrs.materials?.length ? (
                        <p className="mt-1 text-sm capitalize text-muted">{attrs.materials.slice(0, 2).join(", ")}</p>
                      ) : null}
                      <p className="mt-2 text-sm">
                        {formatUsd(p.priceCents)}
                        {stock.get(p.id)?.available === 0 && <span className="eyebrow ml-3">{(stock.get(p.id)?.sold ?? 0) >= p.quantity ? "Sold" : "Reserved"}</span>}
                      </p>
                      {passports.get(p.id)?.status === "verified" && <p className="eyebrow mt-2 text-leaf">✓ Maker evidence</p>}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* From the maker */}
        {voiced && (
          <section className="mt-28 grid gap-10 border-t border-line pt-16 md:grid-cols-[1fr_1.4fr]">
            <div>
              <p className="eyebrow">From the maker</p>
              <p className="mt-4 font-display text-2xl">{store.ownerName}</p>
              {profile && <p className="mt-1 text-sm text-muted">{profile.place}</p>}
              <VoiceButton src={`/api/media/${voiced.voiceNoteId}`} label={`Listen to ${store.ownerName}`} className="mt-8" />
            </div>
            <figure>
              <blockquote className="font-display text-3xl font-normal leading-snug sm:text-4xl" lang="hi">
                “{voiced.sellerTranscript!.split("।")[0]}।”
              </blockquote>
              {voiced.sellerTranslation && (
                <figcaption className="mt-5 max-w-lg text-muted">
                  {voiced.sellerTranslation.split(".")[0]}. <span className="italic">— in her own words, translated</span>
                </figcaption>
              )}
            </figure>
          </section>
        )}

        {/* Made to order */}
        <section className="mt-28 border-t border-line pt-16 text-center">
          <p className="eyebrow">Made to order</p>
          <h2 className="mx-auto mt-5 max-w-xl font-display text-3xl font-normal leading-snug sm:text-4xl">Something in your colours, for your occasion.</h2>
          <p className="mx-auto mt-4 max-w-lg text-muted">
            Tell {store.ownerName} what you have in mind. She answers in her own voice with what she can make, by when, and at what price — and you both approve the same terms before
            you pay.
          </p>
          <Link href={`/s/${store.slug}/custom`} className="mt-8 inline-block bg-ink px-8 py-4 text-sm tracking-wide text-paper hover:bg-ink/85">
            Request a piece
          </Link>
        </section>

        <div className="mt-28">
          <Assurances />
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
