"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const EXAMPLE = "12 hand block-printed cotton scarves in deep red for my bridesmaids, delivered to Austin by December 10. Budget around $300.";

export function CustomRequestForm({ slug, makerName }: { slug: string; makerName: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, text, name, email }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      router.push(body.url);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-10 space-y-6">
      <label className="block">
        <span className="eyebrow">Your request</span>
        <textarea
          required
          minLength={10}
          maxLength={2000}
          rows={5}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={EXAMPLE}
          className="mt-2 w-full resize-y border border-line bg-card p-4 leading-relaxed placeholder:text-muted/70 focus:border-ink focus:outline-none"
        />
      </label>
      <div className="grid gap-6 sm:grid-cols-2">
        <label className="block">
          <span className="eyebrow">Your name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className="mt-2 w-full border-b border-line bg-transparent py-2 focus:border-ink focus:outline-none" />
        </label>
        <label className="block">
          <span className="eyebrow">Email (optional)</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={120} className="mt-2 w-full border-b border-line bg-transparent py-2 focus:border-ink focus:outline-none" />
        </label>
      </div>
      <button type="submit" disabled={busy || text.trim().length < 10} className="w-full bg-ink px-6 py-4 text-paper hover:bg-ink/85 disabled:opacity-30">
        {busy ? "Sending…" : `Send to ${makerName}`}
      </button>
      {error && <p className="text-sm text-danger">{error}</p>}
    </form>
  );
}
