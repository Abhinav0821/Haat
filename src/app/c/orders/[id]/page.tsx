import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { SiteFooter, SiteHeader } from "@/components/craft";
import { PAGE } from "@/components/layout";
import { CollectiveOffer } from "./offer";

export const metadata: Metadata = { title: "Your collective order · Haat" };

/** The buyer's view of a collective order: the terms, who confirmed, approval. */
export default function CollectiveOrderPage(props: PageProps<"/c/orders/[id]">) {
  return (
    <Suspense fallback={<SiteHeader />}>
      <Order params={props.params} />
    </Suspense>
  );
}

async function Order({ params }: { params: PageProps<"/c/orders/[id]">["params"] }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  return (
    <>
      <SiteHeader />
      <main className={`${PAGE} flex-1 py-16 lg:py-20`}>
        <CollectiveOffer orderId={id} />
      </main>
      <SiteFooter />
    </>
  );
}
