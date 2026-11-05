import { notFound } from "next/navigation";
import { Suspense } from "react";
import { SiteFooter, SiteHeader } from "@/components/craft";
import { MessageThread } from "@/components/message-thread";
import { getStore } from "@/lib/queries";

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
      <main className="mx-auto w-full max-w-xl flex-1 px-6 py-20">
        <h1 className="mb-10 font-display text-4xl font-normal">Your conversation with {store.ownerName}</h1>
        <MessageThread makerName={store.ownerName} rootId={messageId} title="Conversation" />
      </main>
      <SiteFooter />
    </>
  );
}
