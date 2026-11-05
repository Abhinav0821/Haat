import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { SiteFooter, SiteHeader } from "@/components/craft";
import { EVIDENCE_LIMITATION, getPassportsFor, type EvidenceResults } from "@/lib/passport/passport";
import { verifyPayload } from "@/lib/passport/signing";
import { getLiveProduct } from "@/lib/queries";
import { MAKER_PROFILES } from "@/lib/store";

export const metadata: Metadata = { title: "Maker Evidence · Haat" };

export default function EvidencePage(props: PageProps<"/s/[slug]/p/[productId]/passport">) {
  return (
    <Suspense fallback={<SiteHeader />}>
      <Evidence params={props.params} />
    </Suspense>
  );
}

const MARK = { good: { sign: "✓", cls: "text-leaf" }, warn: { sign: "!", cls: "text-marigold" }, none: { sign: "–", cls: "text-muted" } };

async function Evidence({ params }: { params: PageProps<"/s/[slug]/p/[productId]/passport">["params"] }) {
  const { slug, productId } = await params;
  await connection();
  const row = await getLiveProduct(slug, productId);
  if (!row) notFound();
  const { product, store } = row;
  const passport = (await getPassportsFor([product.id])).get(product.id);
  if (!passport || passport.status !== "verified" || !passport.payload || !passport.signature) notFound();

  const valid = verifyPayload(passport.payload, passport.signature);
  const checks = passport.checks as { results?: EvidenceResults; retail?: { searched?: number } } | null;
  const r = checks?.results;
  const when = passport.verifiedAt!.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  const place = MAKER_PROFILES[store.slug]?.place;

  const rows = r
    ? [
        {
          t: "Possession photo",
          result: r.possession === "passed" ? "Passed" : r.possession === "failed" ? "Failed" : "Uncertain",
          mark: r.possession === "passed" ? MARK.good : MARK.warn,
          scope: `${store.ownerName} photographed this piece beside a one-time code written by hand, issued by Haat minutes earlier. AI vision read the code and compared the piece with its listing photos.`,
        },
        {
          t: "Retail visual search",
          result: r.retail === "no_match" ? "No identical product found" : r.retail === "possible_match" ? "Possible match found" : "Not run",
          mark: r.retail === "no_match" ? MARK.good : r.retail === "possible_match" ? MARK.warn : MARK.none,
          scope: `Searched ${checks?.retail?.searched ?? "several"} retail listings via Channel3. A search can miss products; “not found” is not proof of absence.`,
        },
        {
          t: "Photo comparison",
          result: r.photos === "no_similar_found" ? "No similar photo found" : "Similar photo found",
          mark: r.photos === "no_similar_found" ? MARK.good : MARK.warn,
          scope: `Compared with ${r.photosScope} other listings on Haat only — not the wider internet.`,
        },
      ]
    : [];

  return (
    <>
      <SiteHeader storeSlug={store.slug} storeName={store.name} />
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-16">
        <p className="eyebrow">Maker Evidence</p>
        <h1 className="mt-4 font-display text-4xl font-normal leading-tight sm:text-5xl">{product.title}</h1>
        <p className="mt-4 text-muted">
          Offered by {store.ownerName}
          {place ? `, ${place}` : ""} · checked {when}
        </p>

        <p className="mt-8 border-l-2 border-ink bg-card px-5 py-4 text-sm leading-relaxed">
          <span className="font-medium">What this shows — and what it doesn’t.</span> {EVIDENCE_LIMITATION.en}
        </p>

        <div className="mt-12 grid gap-10 sm:grid-cols-[1fr_1.2fr]">
          {passport.proofMediaId && (
            <figure>
              <img src={`/api/media/${passport.proofMediaId}`} alt="The maker's proof photo: the piece beside a handwritten code" className="w-full bg-paper-deep object-cover" />
              <figcaption className="mt-2 text-xs text-muted">The possession photo, with the handwritten one-time code.</figcaption>
            </figure>
          )}
          <ol className="space-y-6">
            {rows.map((i) => (
              <li key={i.t} className="border-t border-line pt-4">
                <p className="flex items-baseline justify-between gap-3 text-sm">
                  <span>
                    <span className={`mr-2 ${i.mark.cls}`}>{i.mark.sign}</span>
                    {i.t}
                  </span>
                  <span className="eyebrow">{i.result}</span>
                </p>
                <p className="mt-1 text-sm leading-relaxed text-muted">{i.scope}</p>
              </li>
            ))}
          </ol>
        </div>

        <section className="mt-16 bg-card p-6 text-sm">
          <p className="eyebrow">Signature</p>
          <p className={`mt-3 ${valid ? "text-leaf" : "text-danger"}`}>{valid ? "✓ Signature valid — this record has not been altered since it was issued." : "✗ Signature invalid."}</p>
          <p className="mt-3 break-all font-mono text-xs text-muted">Ed25519 · {passport.signature.slice(0, 48)}…</p>
          <p className="mt-4 text-xs leading-relaxed text-muted">
            A valid signature proves the record is unchanged, not that its claims are true. Fetch the{" "}
            <a href={`/api/passport/${product.id}`} className="underline underline-offset-4">
              signed record
            </a>{" "}
            and verify it with Haat’s{" "}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- raw PEM file, not a page */}
            <a href="/api/passport/public-key" className="underline underline-offset-4">
              public key
            </a>
            .
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
