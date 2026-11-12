"use client";

import { useSyncExternalStore } from "react";
import { isDarkTheme, setTheme, subscribeToTheme } from "@/lib/client/theme";

const serverTheme = () => false;

/** One control for public pages, the studio and personal maker links. */
export function ThemeToggle() {
  const dark = useSyncExternalStore(subscribeToTheme, isDarkTheme, serverTheme);
  const label = dark ? "Switch to light mode · लाइट मोड" : "Switch to dark mode · डार्क मोड";
  return (
    <button
      type="button"
      onClick={() => setTheme(dark ? "light" : "dark")}
      aria-label={label}
      aria-pressed={dark}
      title={label}
      className="inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-2 border border-line bg-card px-3 font-sans text-xs font-normal tracking-normal text-ink transition hover:border-ink hover:bg-paper-deep"
    >
      {dark ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4" aria-hidden="true">
          <path d="M20.3 14A8.5 8.5 0 0 1 10 3.7 8.5 8.5 0 1 0 20.3 14Z" />
        </svg>
      )}
      <span className="hidden sm:inline">{dark ? "Light" : "Dark"}</span>
    </button>
  );
}
