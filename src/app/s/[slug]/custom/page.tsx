import { notFound } from "next/navigation";
import { Suspense } from "react";
import { SiteFooter, SiteHeader } from "@/components/craft";
import { getStore } from "@/lib/queries";
import { CustomRequestForm } from "./request-form";
import { PAGE } from "@/components/layout";

/** A buyer describes something to be made to order. */
export default function CustomPage(props: PageProps<"/s/[slug]/custom">) {
  return (
    <Suspense fallback={<SiteHeader />}>
      <Custom params={props.params} />
    </Suspense>
  );
}

async function Custom({ params }: { params: PageProps<"/s/[slug]/custom">["params"] }) {
  const { slug } = await params;
  const store = await getStore(slug);
  if (!store) notFound();
  return (
    <>
      <SiteHeader storeSlug={store.slug} storeName={store.name} />
      <main className={`${PAGE} grid flex-1 gap-x-16 gap-y-10 py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] lg:py-20`}>
        <div className="min-w-0">
        <p className="eyebrow">Made to order</p>
        <h1 className="mt-4 font-display text-4xl font-normal leading-tight">What would you like {store.ownerName} to make?</h1>
        <p className="mt-4 text-muted">
          Describe it in your own words — how many, colours, fabric, when you need it, and a budget if you have one. {store.ownerName} reads it in Hindi and answers by voice.
        </p>
        <ul className="mt-10 space-y-3 border-t border-line pt-8 text-sm text-muted">
          <li>Her options are checked against her own costs and capacity before you see them, so every price and date she sends is one she can keep.</li>
          <li>Nothing is charged until you and {store.ownerName} have both approved the same, exact terms.</li>
          <li>Payment is through PayPal, for exactly the agreed total.</li>
        </ul>
        </div>
        <div className="min-w-0 lg:pt-2">
          <CustomRequestForm slug={store.slug} makerName={store.ownerName} />
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
