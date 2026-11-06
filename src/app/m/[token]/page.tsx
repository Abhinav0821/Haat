import type { Metadata } from "next";
import { Suspense } from "react";
import { MakerHome } from "./maker";

export const metadata: Metadata = { title: "आपका काम · Haat", robots: { index: false, follow: false }, referrer: "no-referrer" };

/** A maker's own page behind her personal link: her parts of collective orders, and her facts. */
export default function MakerPage(props: PageProps<"/m/[token]">) {
  return (
    <Suspense>
      <Inner params={props.params} />
    </Suspense>
  );
}

async function Inner({ params }: { params: PageProps<"/m/[token]">["params"] }) {
  const { token } = await params;
  return <MakerHome token={token} />;
}
