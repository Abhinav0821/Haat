import Link from "next/link";
import { Suspense } from "react";
import { CheckoutNotice } from "@/components/checkout-notice";
import { SiteFooter, SiteHeader } from "@/components/craft";
import { DEMO_STORE } from "@/lib/store";

const STEPS = [
  { hi: "पूछिए", en: "Ask", body: "A buyer — or their AI shopping agent — describes what they want made: how many, colours, by when, a budget." },
  {
    hi: "बोलिए",
    en: "Answer",
    body: "The maker hears it in Hindi and answers by voice. Every price and date is checked against her own costs and the work she already has; an option that breaks her rules can't be sent.",
  },
  {
    hi: "पक्का",
    en: "Agree & pay",
    body: "Both approve one fingerprinted set of terms. PayPal charges exactly that — and the terms are locked while it does.",
  },
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
          <p className="eyebrow">Custom orders for India’s artisans</p>
          <h1 className="mt-8 font-display text-5xl font-normal leading-[1.05] tracking-tight sm:text-7xl">
            Made to order, <em className="italic">on the maker’s terms.</em>
          </h1>
          <p className="mx-auto mt-8 max-w-xl text-lg font-light leading-relaxed text-muted">
            She states her costs, capacity and conditions by voice, in Hindi. Haat holds every custom order to them — from the first quote to the PayPal payment.
          </p>
          <div className="mt-12 flex flex-wrap justify-center gap-4">
            <Link href={`/s/${DEMO_STORE.slug}/custom`} className="bg-ink px-8 py-3.5 text-sm tracking-wide text-paper transition hover:bg-ink/85">
              Request a piece
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
        <p className="border-t border-line py-10 text-center text-sm text-muted">
          Also for her, by voice: listings from a photo, buyer messages translated and checked for scams, refunds approved by a spoken code word, tracking into PayPal,
          and a daily summary in Hindi. Sellers start at{" "}
          <Link href="/seller/login" className="text-ink underline underline-offset-4">
            the studio
          </Link>
          .
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
