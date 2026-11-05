import Link from "next/link";
import { Suspense } from "react";
import { CheckoutNotice } from "@/components/checkout-notice";
import { SiteFooter, SiteHeader } from "@/components/craft";
import { DEMO_STORE } from "@/lib/store";

const STEPS = [
  { hi: "बोलिए", en: "Speak", body: "Photograph the piece and describe it in Hindi, Tamil or Bengali." },
  { hi: "बेचिए", en: "Sell", body: "Haat writes an honest English listing that people and AI shopping agents can buy with PayPal." },
  { hi: "संभालिए", en: "Manage", body: "Refunds, tracking and scam warnings arrive as spoken questions. Nothing moves without her yes." },
];

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6">
        <Suspense>
          <CheckoutNotice />
        </Suspense>
        <section className="mx-auto max-w-3xl py-24 text-center sm:py-36">
          <p className="eyebrow">A marketplace for India’s artisans</p>
          <h1 className="mt-8 font-display text-5xl font-normal leading-[1.05] tracking-tight sm:text-7xl">
            Sell to the world by voice, <em className="italic">in your own language.</em>
          </h1>
          <p className="mx-auto mt-8 max-w-xl text-lg font-light leading-relaxed text-muted">
            Makers speak; Haat writes the listing, takes payment through PayPal, and asks before anything is refunded.
          </p>
          <div className="mt-12 flex flex-wrap justify-center gap-4">
            <Link href="/seller/list" className="bg-ink px-8 py-3.5 text-sm tracking-wide text-paper transition hover:bg-ink/85">
              Start selling
            </Link>
            <Link
              href={`/s/${DEMO_STORE.slug}`}
              className="border border-ink px-8 py-3.5 text-sm tracking-wide transition hover:bg-ink hover:text-paper"
            >
              Visit {DEMO_STORE.name}
            </Link>
          </div>
        </section>

        <ol className="grid border-t border-line sm:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.en} className="border-b border-line py-10 sm:border-b-0 sm:px-8 sm:first:pl-0 sm:[&:not(:first-child)]:border-l">
              <p className="eyebrow">
                0{i + 1} · {s.en}
              </p>
              <h2 className="mt-4 font-display text-4xl" lang="hi">
                {s.hi}
              </h2>
              <p className="mt-4 leading-relaxed text-muted">{s.body}</p>
            </li>
          ))}
        </ol>
      </main>
      <SiteFooter />
    </>
  );
}
