"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Wordmark } from "@/components/craft";
import { DEMO_STORE } from "@/lib/store-constants";

/**
 * The seller studio's page frame: one column on phones (she works on her phone);
 * on laptops and wider, a wide canvas that each page splits into columns.
 */
export const STUDIO = "mx-auto w-full max-w-7xl px-4 pb-24 pt-8 sm:px-6 lg:px-10 xl:px-12";

/** The same page header on every studio page: Hindi title, English subtitle, optional intro. */
export function StudioHeader({ hi, en, children }: { hi: string; en: string; children?: React.ReactNode }) {
  return (
    <header className="mb-8 sm:mb-10">
      <h1 className="font-display text-3xl font-normal leading-tight sm:text-4xl">
        <span lang="hi">{hi}</span> <span className="whitespace-nowrap font-sans text-base font-light text-muted">{en}</span>
      </h1>
      {children && <div className="mt-3 max-w-2xl space-y-3 text-sm leading-relaxed text-muted">{children}</div>}
    </header>
  );
}

/**
 * Heading for a section OUTSIDE a card (labels inside cards keep the small eyebrow style).
 * Fixed min-height so side-by-side columns start their content at the same line.
 */
export function SectionHeading({ hi, en, action, className = "" }: { hi: string; en: string; action?: React.ReactNode; className?: string }) {
  return (
    <div className={`mb-4 flex min-h-10 items-center justify-between gap-3 ${className}`}>
      <h2 className="font-display text-xl leading-tight">
        <span lang="hi">{hi}</span> <span className="whitespace-nowrap font-sans text-sm font-light text-muted">{en}</span>
      </h2>
      {action}
    </div>
  );
}

/** Empty list, explained: what will appear here and why — same look on every studio page. */
export function EmptyState({ hi, en, detailHi, detailEn, children }: { hi: string; en: string; detailHi: string; detailEn: string; children?: React.ReactNode }) {
  return (
    <div className="border border-dashed border-line bg-card px-6 py-10 text-center sm:px-10 sm:py-12">
      <p className="font-display text-xl" lang="hi">
        {hi}
      </p>
      <p className="text-sm text-muted">{en}</p>
      <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-ink/80" lang="hi">
        {detailHi}
      </p>
      <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted">{detailEn}</p>
      {children && <div className="mt-6">{children}</div>}
    </div>
  );
}

/** Top bar for the seller studio: add, inbox, view shop, sign out. */
export function SellerNav({ active }: { active: "list" | "inbox" | "products" | "ask" | "rules" | "custom" }) {
  const router = useRouter();
  const links = [
    { href: "/seller/inbox", hi: "आज का काम", en: "Inbox", key: "inbox" },
    { href: "/seller/custom", hi: "फ़रमाइश", en: "Custom requests", key: "custom" },
    { href: "/seller/ask", hi: "पूछो", en: "Ask", key: "ask" },
    { href: "/seller/products", hi: "सामान", en: "Pieces", key: "products" },
    { href: "/seller/list", hi: "नया", en: "Add", key: "list" },
    { href: "/seller/rules", hi: "नियम", en: "Rules", key: "rules" },
  ] as const;

  async function signOut() {
    await fetch("/api/seller/logout", { method: "POST" }).catch(() => null);
    router.push("/seller/login");
  }

  return (
    <nav className="mb-10 flex flex-wrap items-center justify-between gap-y-4 border-b border-line pb-5">
      <Link href="/" aria-label="Haat home">
        <Wordmark />
      </Link>
      {/* Phones: links get their own row and scroll sideways, so the page never overflows. */}
      <div className="-mx-4 flex w-[calc(100%+2rem)] items-center gap-5 overflow-x-auto whitespace-nowrap px-4 pb-1 text-sm sm:-mx-6 sm:w-[calc(100%+3rem)] sm:px-6 lg:mx-0 lg:w-auto lg:gap-6 lg:overflow-visible lg:px-0 lg:pb-0 [mask-image:linear-gradient(to_right,black_85%,transparent)] lg:[mask-image:none]">
        {links.map((l) => (
          <Link
            key={l.key}
            href={l.href}
            aria-current={active === l.key ? "page" : undefined}
            className={active === l.key ? "text-ink underline underline-offset-8" : "text-muted hover:text-ink"}
          >
            {l.hi}
            <span className="sr-only"> · {l.en}</span>
          </Link>
        ))}
        <Link href={`/s/${DEMO_STORE.slug}`} className="text-muted hover:text-ink" title="View my shop">
          दुकान
        </Link>
        <button type="button" onClick={signOut} className="eyebrow hover:text-ink" title="Sign out">
          Exit
        </button>
      </div>
    </nav>
  );
}
