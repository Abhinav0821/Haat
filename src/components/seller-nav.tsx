"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Wordmark } from "@/components/craft";
import { DEMO_STORE } from "@/lib/store-constants";

/**
 * The seller studio's page frame: one column on phones (she works on her phone);
 * on laptops and wider, a wide canvas that each page splits into columns.
 */
export const STUDIO = "mx-auto w-full max-w-6xl px-4 pb-24 pt-8 sm:px-6 lg:px-10";

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
      <div className="-mx-4 flex w-[calc(100%+2rem)] items-center gap-5 overflow-x-auto whitespace-nowrap px-4 pb-1 text-sm sm:-mx-6 sm:w-[calc(100%+3rem)] sm:px-6 lg:mx-0 lg:w-auto lg:gap-6 lg:overflow-visible lg:px-0 lg:pb-0">
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
