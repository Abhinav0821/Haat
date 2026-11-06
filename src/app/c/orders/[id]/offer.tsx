"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

type View = {
  id: string;
  collective: string;
  product: string;
  request: { quantity: number; deadline: string; budgetUsdCents: number | null; details: string | null };
  status: string;
  revising: boolean;
  offer: {
    id: string;
    version: number;
    status: string;
    termsHash: string;
    lines: [string, string][];
    totalUsdCents: number;
    makersConfirmed: number;
    makers: number;
    holdUntil: string | null;
    paidAt: string | null;
  } | null;
};

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

export function CollectiveOffer({ orderId }: { orderId: string }) {
  const [view, setView] = useState<View | null>(null);
  const [missing, setMissing] = useState(false);
  const params = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    params.get("checkout") === "failed" ? "The payment didn't complete. You have not been charged." : params.get("paypal") === "cancel" ? "You left PayPal before paying. Nothing was charged." : null,
  );

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const res = await fetch(`/api/c/orders/${orderId}`).catch(() => null);
      if (cancelled || !res) return;
      if (res.status === 404) setMissing(true);
      else if (res.ok) setView(await res.json());
    };
    void tick();
    const t = setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [orderId]);

  async function act(action: "approve" | "checkout") {
    if (!view?.offer) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/c/orders/${orderId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, planId: view.offer.id, hash: view.offer.termsHash }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error);
      if (action === "checkout") {
        if (!out.approveUrl) throw new Error("PayPal did not return a payment link. Nothing was charged.");
        window.location.assign(out.approveUrl);
        return;
      }
      setView(out);
    } catch (e) {
      setError((e as Error).message);
      const res = await fetch(`/api/c/orders/${orderId}`).catch(() => null);
      if (res?.ok) setView(await res.json());
    } finally {
      setBusy(false);
    }
  }

  if (missing) return <p className="text-muted">This order wasn&apos;t found.</p>;
  if (!view) return <p className="text-muted">Loading your order…</p>;
  const { request: r, offer: o } = view;

  return (
    <div>
      <p className="eyebrow">Your request to {view.collective}</p>
      <h1 className="mt-4 font-display text-4xl font-normal leading-tight">
        {r.quantity} × {view.product}
      </h1>
      <p className="mt-3 text-sm text-muted">
        Needed by {day(r.deadline)}
        {r.budgetUsdCents !== null && <> · budget {usd(r.budgetUsdCents)}</>}
        {r.details && <> · {r.details}</>}
      </p>

      {!o && !view.revising && (
        <section className="mt-12 bg-card p-8">
          <p className="font-display text-xl">{view.collective} has your request.</p>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            The coordinator plans it across the collective&apos;s makers. Every date, quantity and price is checked against each maker&apos;s own time and asking price before it
            reaches you. This page updates by itself.
          </p>
        </section>
      )}

      {view.revising && (
        <section className="mt-12 bg-card p-8">
          <p className="font-display text-xl">The terms are being revised.</p>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Something changed on the makers&apos; side since the last terms were made, so they can&apos;t be approved. The coordinator will send revised terms here; nothing was
            charged.
          </p>
        </section>
      )}

      {o && (
        <section className="mt-14 border-t-2 border-ink pt-8">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-display text-2xl">The terms</h2>
            <p className="eyebrow">Version {o.version}</p>
          </div>
          <dl className="mt-6 divide-y divide-line text-sm">
            {o.lines.map(([k, v]) => (
              <div key={k} className="grid grid-cols-[8rem_1fr] gap-4 py-3 sm:grid-cols-[10rem_1fr]">
                <dt className="text-muted">{k}</dt>
                <dd className={k === "Total" ? "font-medium" : k === "Differs from your request" ? "text-marigold" : ""}>{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-xs leading-relaxed text-muted">
            Terms fingerprint{" "}
            <span className="font-mono" title={o.termsHash}>
              {o.termsHash.slice(0, 16)}
            </span>
            . Any change creates a new version for you to approve again.
          </p>

          <p className={`mt-6 text-sm ${o.makersConfirmed === o.makers ? "text-leaf" : "text-muted"}`}>
            {o.makersConfirmed === o.makers ? "✓" : "○"} {o.makers === 1 ? (o.makersConfirmed ? "The maker has confirmed her part on her own link" : "Waiting for the maker to confirm her part on her own link") : `${o.makersConfirmed} of ${o.makers} makers have confirmed their part on their own link`}
          </p>

          {o.status === "awaiting_makers" && <p className="mt-3 text-sm leading-relaxed text-muted">You can approve once every maker has confirmed her part. This page updates by itself.</p>}
          {o.status === "ready" && (
            <button type="button" disabled={busy} onClick={() => void act("approve")} className="mt-6 w-full bg-ink px-6 py-4 text-paper hover:bg-ink/85 disabled:opacity-30">
              I agree to these exact terms
            </button>
          )}
          {o.status === "approved" && (
            <>
              <div className="mt-6 bg-card p-5 text-sm leading-relaxed">
                <p className="text-leaf">✓ You approved these terms. The makers&apos; time and the finishing table are reserved for this order.</p>
                {o.holdUntil && (
                  <p className="mt-1 text-muted">
                    Reserved until {new Date(o.holdUntil).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}. The makers start once you pay.
                  </p>
                )}
              </div>
              <button type="button" disabled={busy} onClick={() => void act("checkout")} className="mt-4 w-full bg-ink px-6 py-4 text-paper hover:bg-ink/85 disabled:opacity-30">
                Pay {usd(o.totalUsdCents)} to {view.collective} with PayPal
              </button>
              <p className="mt-2 text-center text-xs text-muted">You pay the collective, the seller of this order, for exactly the terms above.</p>
            </>
          )}
          {o.status === "paying" && (
            <p className="mt-6 bg-card p-5 text-sm leading-relaxed">
              Your payment is being processed with PayPal. These terms are locked until it completes; this page updates by itself.
            </p>
          )}
          {o.status === "paid" && (
            <div className="mt-6 bg-card p-5 text-sm leading-relaxed">
              <p className="text-leaf">✓ Paid{o.paidAt ? ` on ${new Date(o.paidAt).toLocaleDateString("en-US", { month: "long", day: "numeric" })}` : ""}. Thank you.</p>
              <p className="mt-1 text-muted">The makers now start on their scheduled days; the dispatch date above stands.</p>
            </div>
          )}
        </section>
      )}

      {error && <p className="mt-6 text-sm text-danger">{error}</p>}
    </div>
  );
}
