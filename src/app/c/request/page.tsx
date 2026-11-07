import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "@/components/craft";
import { PAGE } from "@/components/layout";
import { BulkRequestForm } from "./form";

export const metadata: Metadata = { title: "Request a bulk order · Haat" };

const STEPS = [
  ["Describe it in your words", "AI reads your request into quantity, date and budget. You check and correct every field; anything it isn't sure of is marked."],
  ["The collective plans it", "The plan is checked against each maker's recorded days, materials, prices and other promises — by code that shares nothing with the planner. If it can't be done, you're told why and what can."],
  ["Each maker agrees to her part", "On her own link, in Hindi: her pieces, days and pay. You see the terms once every maker has agreed."],
  ["You approve and pay with PayPal", "One payment to the collective, for exactly the approved terms. The makers start once you've paid."],
] as const;

/** A buyer's bulk request to the collective: words → AI reading → the buyer's confirmation → a checked plan. */
export default function BulkRequestPage() {
  return (
    <>
      <SiteHeader />
      <main className={`${PAGE} grid flex-1 gap-x-16 gap-y-12 py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] lg:grid-rows-[auto_1fr] lg:py-20`}>
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <p className="eyebrow">Bulk orders from an artisan collective</p>
          <h1 className="mt-4 font-display text-4xl font-normal leading-tight lg:text-5xl">An order too big for one maker.</h1>
          <p className="mt-5 max-w-xl text-lg font-light leading-relaxed text-muted">
            Ask for 30 or 300 hand block-printed scarves. Haat plans the work across the collective&apos;s makers, each maker agrees to her own part, and you pay the collective once
            with PayPal.
          </p>
        </div>
        <div className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:pt-2">
          <BulkRequestForm />
        </div>
        <ol className="min-w-0 space-y-7 border-t border-line pt-8 lg:col-start-1 lg:row-start-2 lg:self-start">
          {STEPS.map(([title, body], i) => (
            <li key={title} className="grid grid-cols-[2.5rem_1fr] gap-2">
              <span className="eyebrow pt-1">0{i + 1}</span>
              <span>
                <span className="block font-display text-xl">{title}</span>
                <span className="mt-1 block text-sm leading-relaxed text-muted">{body}</span>
              </span>
            </li>
          ))}
        </ol>
      </main>
      <SiteFooter />
    </>
  );
}
