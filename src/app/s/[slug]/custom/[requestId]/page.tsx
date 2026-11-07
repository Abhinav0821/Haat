import { notFound } from "next/navigation";
import { Suspense } from "react";
import { SiteFooter, SiteHeader } from "@/components/craft";
import { getStore } from "@/lib/queries";
import { CustomStatus } from "./custom-status";
import { PAGE } from "@/components/layout";

/** The buyer's view of one custom request: options, counter-offer, agreement, payment. */
export default function CustomRequestPage(props: PageProps<"/s/[slug]/custom/[requestId]">) {
  return (
    <Suspense fallback={<SiteHeader />}>
      <Request params={props.params} />
    </Suspense>
  );
}

async function Request({ params }: { params: PageProps<"/s/[slug]/custom/[requestId]">["params"] }) {
  const { slug, requestId } = await params;
  const store = await getStore(slug);
  if (!store || !/^[0-9a-f-]{36}$/i.test(requestId)) notFound();
  return (
    <>
      <SiteHeader storeSlug={store.slug} storeName={store.name} />
      <main className={`${PAGE} flex-1 py-16 lg:py-20`}>
        <CustomStatus requestId={requestId} makerName={store.ownerName} slug={store.slug} />
      </main>
      <SiteFooter />
    </>
  );
}
