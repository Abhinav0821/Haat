import { notFound } from "next/navigation";
import { Suspense } from "react";
import { SiteFooter, SiteHeader } from "@/components/craft";
import { MessageThread } from "@/components/message-thread";
import { getStore } from "@/lib/queries";
import { PAGE } from "@/components/layout";

/** A buyer's pre-sale question thread with the maker. */
export default function QuestionPage(props: PageProps<"/s/[slug]/q/[messageId]">) {
  return (
    <Suspense fallback={<SiteHeader />}>
      <Question params={props.params} />
    </Suspense>
  );
}

async function Question({ params }: { params: PageProps<"/s/[slug]/q/[messageId]">["params"] }) {
  const { slug, messageId } = await params;
  const store = await getStore(slug);
  if (!store || !/^[0-9a-f-]{36}$/i.test(messageId)) notFound();
  return (
    <>
      <SiteHeader storeSlug={store.slug} storeName={store.name} />
      <main className={`${PAGE} grid flex-1 gap-x-16 gap-y-10 py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:py-20`}>
        <h1 className="font-display text-4xl font-normal leading-tight">Your conversation with {store.ownerName}</h1>
        <div className="min-w-0">
          <MessageThread makerName={store.ownerName} rootId={messageId} title="Conversation" />
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
