import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { SiteFooter, SiteHeader } from "@/components/craft";
import { getPassportsFor } from "@/lib/passport/passport";
import { verifyPayload } from "@/lib/passport/signing";
import { getLiveProduct } from "@/lib/queries";
import { MAKER_PROFILES } from "@/lib/store";

export const metadata: Metadata = { title: "Handmade Passport · Haat" };

export default function PassportPage(props: PageProps<"/s/[slug]/p/[productId]/passport">) {
  return (
    <Suspense fallback={<SiteHeader />}>
      <Passport params={props.params} />
    </Suspense>
  );
}

async function Passport({ params }: { params: PageProps<"/s/[slug]/p/[productId]/passport">["params"] }) {
  const { slug, productId } = await params;
  await connection();
  const row = await getLiveProduct(slug, productId);
  if (!row) notFound();
  const { product, store } = row;
  const passport = (await getPassportsFor([product.id])).get(product.id);
  if (!passport || passport.status !== "verified" || !passport.payload || !passport.signature) notFound();

  const valid = verifyPayload(passport.payload, passport.signature);
  const checks = passport.checks as { massMarket?: { checked: boolean; searched?: number } };
  const when = passport.verifiedAt!.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  const place = MAKER_PROFILES[store.slug]?.place;

  const items = [
    {
      t: "Live proof of possession",
      b: `${store.ownerName} photographed this piece next to a one-time code written by hand, issued by Haat minutes earlier. AI vision read the code and matched the piece to its listing photos.`,
    },
    {
      t: "Not a mass-market product",
      b: checks.massMarket?.checked
        ? `A visual search across ${checks.massMarket.searched ?? "many"} retail listings (Channel3) found no identical factory-made item.`
        : "Retail visual search was unavailable at verification time.",
    },
    { t: "Original photographs", b: "The photos don’t match any other listing on Haat." },
  ];

  return (
    <>
      <SiteHeader storeSlug={store.slug} storeName={store.name} />
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-16">
        <p className="eyebrow">Handmade Passport</p>
        <h1 className="mt-4 font-display text-4xl font-normal leading-tight sm:text-5xl">{product.title}</h1>
        <p className="mt-4 text-muted">
          Made by {store.ownerName}
          {place ? `, ${place}` : ""} · verified {when}
        </p>

        <div className="mt-12 grid gap-10 sm:grid-cols-[1fr_1.2fr]">
          {passport.proofMediaId && (
            <figure>
              <img src={`/api/media/${passport.proofMediaId}`} alt="The maker's proof photo: the piece beside a handwritten code" className="w-full bg-paper-deep object-cover" />
              <figcaption className="mt-2 text-xs text-muted">The proof photo, with the handwritten one-time code.</figcaption>
            </figure>
          )}
          <ol className="space-y-6">
            {items.map((i) => (
              <li key={i.t} className="border-t border-line pt-4">
                <p className="text-sm">
                  <span className="mr-2 text-leaf">✓</span>
                  {i.t}
                </p>
                <p className="mt-1 text-sm leading-relaxed text-muted">{i.b}</p>
              </li>
            ))}
          </ol>
        </div>

        <section className="mt-16 bg-card p-6 text-sm">
          <p className="eyebrow">Signature</p>
          <p className={`mt-3 ${valid ? "text-leaf" : "text-danger"}`}>{valid ? "✓ Signature valid — this passport has not been altered." : "✗ Signature invalid."}</p>
          <p className="mt-3 break-all font-mono text-xs text-muted">Ed25519 · {passport.signature.slice(0, 48)}…</p>
          <p className="mt-4 text-xs leading-relaxed text-muted">
            Anyone can check it: fetch the{" "}
            <a href={`/api/passport/${product.id}`} className="underline underline-offset-4">
              signed record
            </a>{" "}
            and verify it with Haat’s{" "}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- raw PEM file, not a page */}
            <a href="/api/passport/public-key" className="underline underline-offset-4">
              public key
            </a>
            . We don’t claim to detect AI-generated images; this passport rests on live possession, retail search and photo originality.
          </p>
        </section>

        <Link href={`/s/${store.slug}/p/${product.id}`} className="eyebrow mt-12 inline-block text-ink underline underline-offset-8">
          ← Back to the piece
        </Link>
      </main>
      <SiteFooter />
    </>
  );
}
