"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Wordmark } from "@/components/craft";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"];

export function PinPad() {
  const router = useRouter();
  const params = useSearchParams();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next = (() => {
    const n = params.get("next") ?? "/seller/inbox";
    return n.startsWith("/seller") ? n : "/seller/inbox"; // never redirect off-site
  })();

  const submit = useCallback(
    async (code: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/seller/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ passcode: code }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "Could not sign in");
        router.replace(next);
      } catch (e) {
        setError((e as Error).message);
        setPin("");
        setBusy(false);
      }
    },
    [next, router],
  );

  const press = useCallback(
    (k: string) => {
      if (busy) return;
      setError(null);
      if (k === "⌫") setPin((p) => p.slice(0, -1));
      else if (/^\d$/.test(k)) setPin((p) => (p.length < 12 ? p + k : p));
    },
    [busy],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") press("⌫");
      else if (e.key === "Enter" && pin.length >= 4) void submit(pin);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press, pin, submit]);

  return (
    <div className="mx-auto flex w-full max-w-xs flex-1 flex-col justify-center px-6 py-16">
      <div className="text-center">
        <Wordmark />
        <p className="eyebrow mt-10"><span className="deva">विक्रेता</span> · Seller studio</p>
        <h1 className="mt-3 font-display text-3xl font-normal">
          पासकोड डालें
          <span className="mt-1 block font-sans text-sm font-light text-muted">Enter your passcode</span>
        </h1>
      </div>

      <div className="mt-8 flex justify-center gap-3" aria-live="polite" aria-label={`${pin.length} digits entered`}>
        {Array.from({ length: Math.max(6, pin.length) }, (_, i) => (
          <span key={i} className={`h-3 w-3 rounded-full border border-ink ${i < pin.length ? "bg-ink" : ""}`} />
        ))}
      </div>
      <p className="mt-4 min-h-5 text-center text-sm text-danger" role="alert">
        {error}
      </p>

      <div className="mt-4 grid grid-cols-3 gap-3">
        {KEYS.map((k, i) =>
          k === "" ? (
            <span key={i} />
          ) : (
            <button
              key={i}
              type="button"
              onClick={() => press(k)}
              disabled={busy}
              aria-label={k === "⌫" ? "Delete" : k}
              className="h-16 border border-line bg-card font-display text-2xl transition hover:border-ink active:bg-paper-deep disabled:opacity-40"
            >
              {k}
            </button>
          ),
        )}
      </div>

      <button
        type="button"
        onClick={() => submit(pin)}
        disabled={busy || pin.length < 4}
        className="mt-6 bg-ink py-4 text-sm tracking-wide text-paper transition hover:bg-ink/85 disabled:opacity-30"
      >
        {busy ? "…" : "खोलें · Open"}
      </button>
    </div>
  );
}
