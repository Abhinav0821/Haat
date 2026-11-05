"use client";

import { useEffect, useState } from "react";
import { speak } from "@/lib/client/media";

type Brief = {
  hi: string;
  en: string;
  numbers: { paidOrders: number; netCents: number; toShip: number; pendingApprovals: number; scamWarnings: number; inrPerUsd: number };
};

/** "आज का हाल" — the seller's daily summary, read aloud in Hindi. */
export function DailyBrief({ refreshKey }: { refreshKey: number }) {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [showEn, setShowEn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/seller/brief").catch(() => null);
      if (!cancelled && res?.ok) setBrief(await res.json());
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (!brief) return null;
  const n = brief.numbers;
  const stats = [
    { label: "कमाई · Earned (24h)", value: `₹${Math.round((n.netCents / 100) * n.inrPerUsd).toLocaleString("en-IN")}` },
    { label: "ऑर्डर · Orders", value: String(n.paidOrders) },
    { label: "भेजने हैं · To ship", value: String(n.toShip) },
    { label: "मंज़ूरी · Approvals", value: String(n.pendingApprovals) },
  ];

  return (
    <section className="mb-14 bg-card p-6">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow">आज का हाल · Today</p>
        <button
          type="button"
          onClick={() => speak(brief.hi, "hindi")}
          className="rounded-full border border-ink px-4 py-1.5 text-sm transition hover:bg-ink hover:text-paper"
        >
          🔊 सुनें
        </button>
      </div>
      <dl className="mt-5 grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="bg-card py-3 pr-3">
            <dd className="font-display text-3xl">{s.value}</dd>
            <dt className="mt-1 text-[11px] text-muted">{s.label}</dt>
          </div>
        ))}
      </dl>
      {n.scamWarnings > 0 && (
        <p className="mt-4 border-l-2 border-danger pl-3 text-sm text-danger">
          {n.scamWarnings} संदेशों में धोखे के संकेत · scam warnings today
        </p>
      )}
      <p className="mt-5 leading-relaxed" lang="hi">
        {brief.hi}
      </p>
      <button type="button" onClick={() => setShowEn((s) => !s)} className="mt-2 text-xs text-muted underline underline-offset-4">
        {showEn ? "Hide English" : "English"}
      </button>
      {showEn && <p className="mt-2 text-sm text-muted">{brief.en}</p>}
    </section>
  );
}
