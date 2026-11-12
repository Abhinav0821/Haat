import Link from "next/link";
import { Suspense } from "react";
import { CheckoutNotice } from "@/components/checkout-notice";
import { SiteFooter, SiteHeader } from "@/components/craft";
import { DEMO_STORE } from "@/lib/store";
import { PAGE } from "@/components/layout";

const PRINCIPLE = [
  ["AI assists.", "It reads a buyer's words into quantity, date and budget. The buyer checks every field; nothing it guesses is treated as stated."],
  ["Code checks.", "Every plan, refusal and alternative is checked against the facts recorded for the makers, by a checker that shares no code with the planner."],
  ["Makers decide.", "Each maker agrees to her own part (pieces, days, pay) on her personal link, in Hindi or English. A changed part is asked again."],
  ["Buyers pay with PayPal.", "One payment to the collective, for exactly the approved terms. Each maker's share is tracked until she confirms she received it."],
] as const;

const LOOP = [
  { n: "01", hi: "माँग", en: "The request", body: "A boutique asks for 30 or 300 pieces by a date — in plain words, or through its own AI agent over MCP." },
  { n: "02", hi: "योजना", en: "The plan", body: "Haat splits the work across the makers' recorded days, materials, prices and other promises. Yes; no, with the reason and what would work; or a focused question about what's missing." },
  { n: "03", hi: "हाँ", en: "Her part", body: "Each maker sees only her own part on her link and says yes or no. If a plan changes, agreed parts are kept where possible." },
  { n: "04", hi: "भुगतान", en: "Payment", body: "The buyer approves the exact terms and pays the collective through PayPal. The makers start once it's paid." },
  { n: "05", hi: "हिस्सा", en: "Her share", body: "The coordinator pays each maker by UPI or bank and records the reference. Only her link can confirm it arrived." },
] as const;

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main className={`${PAGE} flex-1`}>
        <Suspense>
          <CheckoutNotice />
        </Suspense>
        <section className="grid gap-x-20 gap-y-14 py-20 sm:py-28 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:items-end">
          <div>
            <p className="eyebrow">Bulk orders from India&apos;s artisan collectives</p>
            <h1 className="mt-8 font-display text-5xl font-normal leading-[1.05] tracking-tight sm:text-7xl">
              Bigger orders <em className="italic">for small makers.</em>
            </h1>
            <p className="mt-8 max-w-2xl text-lg font-light leading-relaxed text-muted">
              Haat helps artisan collectives turn bulk requests into checked work plans, get each maker&apos;s agreement on her part, collect one buyer payment through PayPal, and
              track each maker&apos;s share until she confirms receipt.
            </p>
            <div className="mt-12 flex flex-wrap gap-4">
              <Link href="/c/request" className="bg-ink px-8 py-3.5 text-sm tracking-wide text-paper transition hover:bg-ink/85">
                Request a bulk order
              </Link>
              <Link href="/seller/collective" className="border border-ink px-8 py-3.5 text-sm tracking-wide transition hover:bg-ink hover:text-paper">
                Coordinator&apos;s studio
              </Link>
              <Link href="/agent" className="px-2 py-3.5 text-sm tracking-wide underline underline-offset-4 transition hover:text-muted">
                Ask through your AI agent
              </Link>
              <a href="https://youtu.be/JWpLjkx_Hnk" target="_blank" rel="noopener noreferrer" className="px-2 py-3.5 text-sm tracking-wide underline underline-offset-4 transition hover:text-muted">
                Watch the 3-minute demo ↗
              </a>
            </div>
          </div>
          <dl className="divide-y divide-line border-y border-line">
            {PRINCIPLE.map(([k, v]) => (
              <div key={k} className="grid gap-1 py-5 sm:grid-cols-[13rem_1fr] sm:gap-6">
                <dt className="font-display text-2xl leading-tight">{k}</dt>
                <dd className="text-sm leading-relaxed text-muted">{v}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="border-t border-line py-16">
          <p className="eyebrow">How an order moves</p>
          <ol className="mt-8 grid gap-y-10 sm:grid-cols-2 lg:grid-cols-5">
            {LOOP.map((s) => (
              <li key={s.n} className="lg:border-l lg:border-line lg:px-6 lg:first:border-l-0 lg:first:pl-0">
                <p className="eyebrow">
                  {s.n} · {s.en}
                </p>
                <h2 className="mt-3 font-display text-3xl" lang="hi">
                  {s.hi}
                </h2>
                <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted">{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="grid gap-10 border-t border-line py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <h2 className="font-display text-3xl leading-tight">What &ldquo;checked&rdquo; means</h2>
          <div className="grid gap-8 text-sm leading-relaxed text-muted sm:grid-cols-2">
            <p>
              A plan is checked for consistency with what the makers and the coordinator have recorded: each maker&apos;s days, materials date, other promises and price, and the
              shared finishing table. The checker shares no code with the planner, so it can reject the planner&apos;s answer.
            </p>
            <p>
              It cannot tell whether those facts are true, whether every piece will match, or whether a courier will be on time. A personal link shows who holds the link, not who
              they are. These limits are shown, not hidden.
            </p>
          </div>
        </section>

        <p className="border-t border-line py-10 text-sm text-muted">
          Also built on Haat: a single maker&apos;s shop with{" "}
          <Link href={`/s/${DEMO_STORE.slug}`} className="text-ink underline underline-offset-4">
            ready pieces
          </Link>{" "}
          and{" "}
          <Link href={`/s/${DEMO_STORE.slug}/custom`} className="text-ink underline underline-offset-4">
            custom orders
          </Link>
          , run by voice in Hindi.
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
