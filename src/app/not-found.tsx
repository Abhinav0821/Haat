import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/craft";

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center px-6 py-28 text-center">
        <p className="eyebrow">404</p>
        <h1 className="mt-4 font-display text-4xl font-normal">This piece isn’t here.</h1>
        <p className="mt-3 text-muted">It may have sold, or the link is incomplete.</p>
        <Link href="/" className="eyebrow mt-10 text-ink underline underline-offset-8">
          Back to Haat
        </Link>
      </main>
      <SiteFooter />
    </>
  );
}
