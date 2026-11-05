import Link from "next/link";

/** Bilingual wordmark: letterspaced serif HAAT, hairline, हाट. */
export function Wordmark({ className = "", compactOnPhone = false }: { className?: string; compactOnPhone?: boolean }) {
  const hiOnly = compactOnPhone ? "hidden sm:inline-block" : "";
  return (
    <span className={`inline-flex items-center gap-3 text-ink ${className}`}>
      <span className="font-display text-[1.35rem] font-medium uppercase leading-none tracking-[0.42em] [margin-right:-0.42em]">
        Haat
      </span>
      <span aria-hidden className={`h-4 w-px bg-line ${hiOnly}`} />
      <span className={`text-[0.95rem] font-light leading-none text-muted ${hiOnly}`} lang="hi">
        हाट
      </span>
    </span>
  );
}

export function SiteHeader({ storeSlug, storeName }: { storeSlug?: string; storeName?: string }) {
  return (
    <header className="border-b border-line">
      <nav className="mx-auto grid h-16 max-w-6xl grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 sm:px-6">
        <div className="eyebrow min-w-0 truncate">
          {storeSlug ? (
            <Link href={`/s/${storeSlug}`} className="hover:text-ink">
              {storeName ?? "Collection"}
            </Link>
          ) : (
            <Link href="/" className="hover:text-ink">
              Home
            </Link>
          )}
        </div>
        <Link href="/" aria-label="Haat home">
          <Wordmark compactOnPhone />
        </Link>
        <div className="eyebrow text-right">
          <Link href="/seller/list" className="hover:text-ink">
            Sell<span className="hidden sm:inline"> on Haat</span>
          </Link>
        </div>
      </nav>
    </header>
  );
}

/** Quiet placeholder when a product has no photograph yet. */
export function ProductArt({ className = "" }: { title?: string; seed?: string; className?: string }) {
  return (
    <div className={`flex items-center justify-center bg-paper-deep ${className}`}>
      <svg viewBox="0 0 48 48" className="h-10 w-10 text-muted/50" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden>
        {Array.from({ length: 8 }, (_, i) => (
          <ellipse key={i} cx="24" cy="13" rx="3.2" ry="8" transform={`rotate(${i * 45} 24 24)`} />
        ))}
        <circle cx="24" cy="24" r="3" />
      </svg>
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-28 border-t border-line">
      <div className="mx-auto grid max-w-6xl gap-6 px-6 py-12 sm:grid-cols-[1fr_auto] sm:items-end">
        <div>
          <Wordmark />
          <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted">
            A marketplace for India’s artisans, run by voice in their own language. Payments by PayPal.
          </p>
        </div>
        <p className="eyebrow">Sandbox demo · PayPal AI Hackathon 2026</p>
      </div>
    </footer>
  );
}

export function Assurances() {
  const items = [
    ["Secure checkout", "Paid through PayPal, with Buyer Protection on every order."],
    ["Made by hand", "Each piece is printed and finished by the maker herself."],
    ["Shipped from India", "Sent with tracking to the address in your PayPal account."],
  ];
  return (
    <dl className="grid gap-8 border-y border-line py-10 sm:grid-cols-3">
      {items.map(([t, b]) => (
        <div key={t}>
          <dt className="eyebrow text-ink">{t}</dt>
          <dd className="mt-2 text-sm leading-relaxed text-muted">{b}</dd>
        </div>
      ))}
    </dl>
  );
}
