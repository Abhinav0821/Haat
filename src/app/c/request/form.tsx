"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { plural } from "@/lib/collective/intake";

type Status = "stated" | "assumed" | "missing";
type Field<T> = { value: T | null; status: Status; words: string | null; note: string | null };
type Interpretation = {
  quantity: Field<number>;
  deadline: Field<string>;
  budgetUsdCents: Field<number>;
  details: Field<string>;
  product: { matches: "yes" | "no" | "unclear"; asked: string | null; note: string | null };
  questions: string[];
};
type Info = { collective: string; product: string; earliest: string };

const field = "w-full border-b border-line bg-transparent py-2.5 text-base focus:border-ink focus:outline-none";
const EXAMPLE = "Hi — we're a boutique in Portland. We'd like 30 indigo block-printed cotton scarves, delivered in four weeks. Our total budget is $300.";

function Badge({ f }: { f?: Field<unknown> }) {
  if (!f) return null;
  if (f.status === "stated") return <span className="text-xs text-leaf">from your words</span>;
  if (f.status === "assumed") return <span className="text-xs text-marigold">please check</span>;
  return <span className="text-xs text-muted">needed</span>;
}

export function BulkRequestForm() {
  const router = useRouter();
  const [info, setInfo] = useState<Info | null>(null);
  const [text, setText] = useState("");
  const [step, setStep] = useState<"words" | "confirm">("words");
  const [reading, setReading] = useState<{ interpretation: Interpretation; model: string } | null>(null);
  const [form, setForm] = useState({ quantity: "", deadline: "", budgetUsd: "", details: "", buyerName: "", buyerEmail: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/c/requests")
      .then((r) => (r.ok ? r.json() : null))
      .then(setInfo)
      .catch(() => null);
  }, []);

  async function read() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/c/requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "read", text }) });
      const out = await res.json();
      if (!res.ok) {
        setError(out.error);
        if (out.fallback || res.status === 429) manual();
        return;
      }
      const i = out.interpretation as Interpretation;
      setReading(out);
      setForm((f) => ({
        ...f,
        quantity: i.quantity.value !== null ? String(i.quantity.value) : "",
        deadline: i.deadline.value ?? "",
        budgetUsd: i.budgetUsdCents.value !== null ? (i.budgetUsdCents.value / 100).toFixed(2) : "",
        details: i.details.value ?? "",
      }));
      setStep("confirm");
    } catch {
      setError("We couldn't read the request just now. Please fill in the details yourself.");
      manual();
    } finally {
      setBusy(false);
    }
  }

  function manual() {
    setReading(null);
    setStep("confirm");
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/c/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", text, ...form, quantity: Number(form.quantity), proposed: reading?.interpretation ?? null, model: reading?.model ?? null, via: reading ? "ai" : "form" }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error);
      router.push(out.url);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const i = reading?.interpretation;

  if (step === "words") {
    return (
      <div>
        <label className="block">
          <span className="eyebrow">Your request{info ? ` to ${info.collective}` : ""}</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={7}
            maxLength={2000}
            placeholder={EXAMPLE}
            className="mt-4 w-full border border-line bg-card p-5 text-lg leading-relaxed placeholder:text-muted/60 focus:border-ink focus:outline-none"
          />
        </label>
        <p className="mt-3 text-sm text-muted">How many, by when, a budget if you have one, and anything about colour or size. {info && <>The collective makes {plural(info.product)}.</>}</p>
        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
          <button type="button" disabled={busy || text.trim().length < 5} onClick={() => void read()} className="bg-ink px-8 py-3.5 text-sm tracking-wide text-paper hover:bg-ink/85 disabled:opacity-30">
            {busy ? "Reading…" : "Read my request"}
          </button>
          <button type="button" onClick={manual} className="text-sm underline underline-offset-4">
            Fill in the details myself
          </button>
          {!text && (
            <button type="button" onClick={() => setText(EXAMPLE)} className="text-sm text-muted underline underline-offset-4 hover:text-ink">
              Use an example
            </button>
          )}
        </div>
        <p className="mt-6 text-xs leading-relaxed text-muted">AI only proposes a reading of your words. Nothing is planned until you confirm each field on the next step.</p>
        {error && <p className="mt-4 text-sm text-danger">{error}</p>}
      </div>
    );
  }

  return (
    <form onSubmit={send}>
      <div className="flex items-baseline justify-between gap-4">
        <p className="eyebrow">{i ? "Check what we understood" : "Your requirements"}</p>
        <button type="button" onClick={() => setStep("words")} className="text-sm underline underline-offset-4">
          ← Your words
        </button>
      </div>
      {i && text && <p className="mt-4 border-l-2 border-line pl-4 text-sm italic leading-relaxed text-muted">“{text}”</p>}
      {i?.product.note && <p className="mt-5 bg-card p-4 text-sm text-marigold">{i.product.note}</p>}

      <div className="mt-8 grid gap-x-10 gap-y-7 sm:grid-cols-2">
        <label className="block text-sm text-muted">
          <span className="flex items-baseline justify-between gap-2">
            Pieces <Badge f={i?.quantity} />
          </span>
          <input inputMode="numeric" required value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value.replace(/\D/g, "") })} className={`${field} text-ink`} />
          {i?.quantity.note && <span className="mt-1 block text-xs text-marigold">{i.quantity.note}</span>}
        </label>
        <label className="block text-sm text-muted">
          <span className="flex items-baseline justify-between gap-2">
            Delivered by <Badge f={i?.deadline} />
          </span>
          <input type="date" required min={info?.earliest} value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} className={`${field} text-ink`} />
          {i?.deadline.note && <span className="mt-1 block text-xs text-marigold">{i.deadline.note}</span>}
        </label>
        <label className="block text-sm text-muted">
          <span className="flex items-baseline justify-between gap-2">
            Budget, US dollars (optional) <Badge f={i && i.budgetUsdCents.status !== "missing" ? i.budgetUsdCents : undefined} />
          </span>
          <input inputMode="decimal" value={form.budgetUsd} onChange={(e) => setForm({ ...form, budgetUsd: e.target.value.replace(/[^0-9.]/g, "") })} className={`${field} text-ink`} />
          {i?.budgetUsdCents.note && <span className="mt-1 block text-xs text-marigold">{i.budgetUsdCents.note}</span>}
        </label>
        <label className="block text-sm text-muted sm:row-span-2">
          <span className="flex items-baseline justify-between gap-2">
            Colour, size, other requirements {i?.details.value && <Badge f={i.details} />}
          </span>
          <textarea maxLength={300} rows={3} value={form.details} onChange={(e) => setForm({ ...form, details: e.target.value })} className={`${field} text-ink`} />
          {i?.details.note && <span className="mt-1 block text-xs text-muted">{i.details.note}</span>}
        </label>
        <label className="block text-sm text-muted">
          Your name or shop (optional)
          <input maxLength={80} value={form.buyerName} onChange={(e) => setForm({ ...form, buyerName: e.target.value })} className={`${field} text-ink`} />
        </label>
        <label className="block text-sm text-muted">
          Email, for the coordinator (optional)
          <input type="email" maxLength={254} value={form.buyerEmail} onChange={(e) => setForm({ ...form, buyerEmail: e.target.value })} className={`${field} text-ink`} />
        </label>
      </div>

      {i && i.questions.length > 0 && (
        <ul className="mt-8 space-y-1.5 border-t border-line pt-5 text-sm text-muted">
          {i.questions.map((q) => (
            <li key={q}>? {q}</li>
          ))}
        </ul>
      )}

      <div className="mt-10 border-t-2 border-ink pt-6">
        <p className="text-sm leading-relaxed text-muted">
          You&apos;re asking {info?.collective ?? "the collective"} for{" "}
          <span className="text-ink">
            {form.quantity || "…"} {info ? plural(info.product) : "pieces"}
          </span>{" "}
          delivered by <span className="text-ink">{form.deadline || "…"}</span>
          {form.budgetUsd && (
            <>
              {" "}
              within <span className="text-ink">${form.budgetUsd}</span>
            </>
          )}
          . Nothing is charged now: you&apos;ll see checked terms once the makers have agreed to their parts.
        </p>
        <button type="submit" disabled={busy || !form.quantity || !form.deadline} className="mt-6 bg-ink px-8 py-3.5 text-sm tracking-wide text-paper hover:bg-ink/85 disabled:opacity-30">
          {busy ? "Sending…" : "Confirm and send to the collective"}
        </button>
        {error && <p className="mt-4 text-sm text-danger">{error}</p>}
      </div>
    </form>
  );
}
