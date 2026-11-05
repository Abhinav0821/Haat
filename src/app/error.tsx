"use client";

import { useEffect } from "react";

export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center px-6 py-28 text-center">
      <p className="eyebrow">Something went wrong</p>
      <h1 className="mt-4 font-display text-4xl font-normal">
        कुछ गड़बड़ हो गई
        <span className="mt-2 block font-sans text-base font-light text-muted">We couldn’t load this page. No payment was affected.</span>
      </h1>
      <button
        type="button"
        onClick={() => retry()}
        className="mt-10 border border-ink px-8 py-3 text-sm tracking-wide transition hover:bg-ink hover:text-paper"
      >
        फिर कोशिश करें · Try again
      </button>
    </main>
  );
}
