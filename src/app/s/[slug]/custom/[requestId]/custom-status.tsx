"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { MessageThread } from "@/components/message-thread";

type View = {
  id: string;
  status: "new" | "options_sent" | "agreement" | "paid" | "declined";
  request: { text: string; quantity: number; item: string; colors: string[]; materials: string[]; deadline: string | null; budgetUsdCents: number | null };
  options: {
    index: number;
    quantity: number;
    unitPriceUsdCents: number;
    totalUsdCents: number;
    readyBy: string;
    estimatedDelivery: string;
    colors: string[] | null;
    materials: string[] | null;
    note: string | null;
    notes: string[];
  }[];
  counter: {
    quantity: number;
    totalBudgetUsdCents: number;
    acceptable: boolean;
    reason: string | null;
    alternatives: { index: number; quantity: number; totalUsdCents: number; text: string }[];
  } | null;
  agreement: {
    id: string;
    version: number;
    status: string;
    termsHash: string;
    lines: [string, string][];
    totalUsdCents: number;
    buyerApproved: boolean;
    sellerApproved: boolean;
    holdUntil: string | null;
    payable: boolean;
    blockedBecause: string | null;
    progress: { done: number; total: number; readyBy: string } | null;
    tracking: { number: string; carrier: string | null } | null;
    orderId?: string | null;
  } | null;
};

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
const STEPS = ["Sent", "Options", "Terms agreed", "Paid"] as const;

export function CustomStatus({ requestId, makerName, slug }: { requestId: string; makerName: string; slug: string }) {
  const params = useSearchParams();
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(params.get("checkout") === "failed" ? "Payment didn't complete. You have not been charged." : null);
  const [counterQty, setCounterQty] = useState("");
  const [counterTotal, setCounterTotal] = useState("");

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const res = await fetch(`/api/custom/${requestId}`).catch(() => null);
      if (!cancelled && res?.ok) setView(await res.json());
    };
    void tick();
    const t = setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [requestId]);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/custom/${requestId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error);
      if (body.action === "checkout") {
        if (!out.approveUrl) throw new Error("PayPal did not return a payment link.");
        window.location.assign(out.approveUrl);
        return;
      }
      setView(out);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!view) return <p className="text-muted">Loading your request…</p>;
  const { request: r, agreement: a } = view;
  const step = view.status === "paid" ? 3 : a?.status === "approved" ? 2 : view.options.length || a ? 1 : 0;

  return (
    <div>
      <p className="eyebrow">Your request to {makerName}</p>
      <h1 className="mt-4 font-display text-4xl font-normal leading-tight">
        {r.quantity} × {r.item}
      </h1>
      <p className="mt-3 text-sm capitalize text-muted">
        {[...r.colors, ...r.materials].join(" · ")}
        {r.deadline && <span className="normal-case"> · needed by {day(r.deadline)}</span>}
        {r.budgetUsdCents && <span className="normal-case"> · budget {usd(r.budgetUsdCents)}</span>}
      </p>
      <blockquote className="mt-6 border-l border-line pl-4 text-sm italic text-muted">“{r.text}”</blockquote>

      <ol className="mt-12 grid grid-cols-4 gap-2 text-center text-xs">
        {STEPS.map((s, i) => (
          <li key={s} className={`border-t-2 pt-3 ${i <= step ? "border-ink text-ink" : "border-line text-muted"}`}>
            {s}
          </li>
        ))}
      </ol>

      {view.status === "declined" && <p className="mt-12 bg-card p-6">{makerName} can&apos;t take this order. Nothing was charged.</p>}

      {view.status === "paid" && (
        <section className="mt-12 bg-card p-8 text-center">
          <p className="eyebrow text-leaf">Paid</p>
          <p className="mt-3 font-display text-2xl">Thank you. {makerName} has your order.</p>
          <p className="mt-2 text-sm text-muted">She works to the terms below — you&apos;ll get tracking when it ships.</p>
          {a?.progress && (
            <div className="mx-auto mt-6 max-w-sm text-left">
              <div className="h-1.5 bg-line" aria-hidden>
                <div className="h-1.5 bg-ink" style={{ width: `${Math.round((a.progress.done / a.progress.total) * 100)}%` }} />
              </div>
              <p className="mt-2 text-center text-sm">
                {a.progress.done} of {a.progress.total} pieces made · ready by {day(a.progress.readyBy)}
              </p>
            </div>
          )}
          {a?.tracking && (
            <p className="mt-4 text-sm">
              Shipped with {a.tracking.carrier} · tracking <span className="font-mono">{a.tracking.number}</span>
            </p>
          )}
          {a?.orderId && (
            <a href={`/s/${slug}/order/${a.orderId}`} className="mt-6 inline-block text-sm underline underline-offset-4">
              Order details &amp; messages with {makerName}
            </a>
          )}
        </section>
      )}

      {!view.options.length && !a && view.status === "new" && (
        <section className="mt-12 bg-card p-8">
          <p className="font-display text-xl">{makerName} has your request.</p>
          <p className="mt-2 text-sm text-muted">
            She answers by voice, usually within a day. Her options are checked against her own costs and the work she already has before they reach you. This page updates by
            itself.
          </p>
        </section>
      )}

      {view.options.length > 0 && view.status !== "paid" && (
        <section className="mt-14">
          <h2 className="eyebrow text-ink">{makerName}&apos;s options</h2>
          <ul className="mt-4 space-y-4">
            {view.options.map((o) => (
              <li key={o.index} className="border border-line bg-card p-6">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <p className="font-display text-2xl">
                    {o.quantity} pieces · {usd(o.unitPriceUsdCents)} each
                  </p>
                  <p className="text-lg">{usd(o.totalUsdCents)} <span className="text-xs text-muted">incl. shipping</span></p>
                </div>
                <p className="mt-2 text-sm text-muted">
                  Ready by {day(o.readyBy)} · estimated delivery {day(o.estimatedDelivery)}
                </p>
                {(o.colors || o.materials) && <p className="mt-1 text-sm capitalize">{[...(o.colors ?? []), ...(o.materials ?? [])].join(" · ")}</p>}
                {o.note && <p className="mt-1 text-sm">“{o.note}”</p>}
                {o.notes.map((n) => (
                  <p key={n} className="mt-2 text-xs text-marigold">
                    {n}
                  </p>
                ))}
                <button type="button" disabled={busy} onClick={() => act({ action: "choose", kind: "option", index: o.index })} className="mt-5 border border-ink px-5 py-2 text-sm hover:bg-ink hover:text-paper disabled:opacity-30">
                  Choose this
                </button>
              </li>
            ))}
          </ul>

          <form
            className="mt-8 border-t border-line pt-6"
            onSubmit={(e) => {
              e.preventDefault();
              void act({ action: "counter", quantity: Number(counterQty), totalUsd: Number(counterTotal) });
            }}
          >
            <p className="eyebrow">Or suggest your own</p>
            <div className="mt-3 flex flex-wrap items-end gap-4 text-sm">
              <label>
                Pieces
                <input value={counterQty} onChange={(e) => setCounterQty(e.target.value.replace(/\D/g, ""))} inputMode="numeric" className="ml-2 w-16 border-b border-line bg-transparent py-1 focus:border-ink focus:outline-none" />
              </label>
              <label>
                Total budget $
                <input value={counterTotal} onChange={(e) => setCounterTotal(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" className="ml-1 w-24 border-b border-line bg-transparent py-1 focus:border-ink focus:outline-none" />
              </label>
              <button type="submit" disabled={busy || !counterQty || !counterTotal} className="underline underline-offset-4 disabled:opacity-30">
                Ask
              </button>
            </div>
            <p className="mt-2 text-xs text-muted">Answered instantly from {makerName}&apos;s own rules; she still approves any terms herself.</p>
          </form>

          {view.counter && !view.counter.acceptable && (
            <div className="mt-6 bg-paper-deep/60 p-5 text-sm">
              <p>
                {view.counter.quantity} pieces for {usd(view.counter.totalBudgetUsdCents)}: {view.counter.reason}
              </p>
              {view.counter.alternatives.length > 0 && (
                <ul className="mt-3 space-y-2">
                  {view.counter.alternatives.map((x) => (
                    <li key={x.index} className="flex flex-wrap items-center justify-between gap-3">
                      <span>{x.text}</span>
                      <button type="button" disabled={busy} onClick={() => act({ action: "choose", kind: "alternative", index: x.index })} className="underline underline-offset-4 disabled:opacity-30">
                        Choose
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      {a && a.status !== "cancelled" && (
        <section className="mt-14 border-t-2 border-ink pt-8">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-display text-2xl">The terms</h2>
            <p className="eyebrow">Version {a.version}</p>
          </div>
          <dl className="mt-6 divide-y divide-line text-sm">
            {a.lines.map(([k, v]) => (
              <div key={k} className="grid grid-cols-[9rem_1fr] gap-4 py-3">
                <dt className="text-muted">{k}</dt>
                <dd className={k === "Total" ? "font-medium" : ""}>{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 font-mono text-[11px] text-muted" title={a.termsHash}>
            Terms fingerprint {a.termsHash.slice(0, 16)} — any change creates a new version that both of you approve again.
          </p>

          <div className="mt-6 flex gap-6 text-sm">
            <span className={a.buyerApproved ? "text-leaf" : "text-muted"}>{a.buyerApproved ? "✓" : "○"} You</span>
            <span className={a.sellerApproved ? "text-leaf" : "text-muted"}>{a.sellerApproved ? "✓" : "○"} {makerName}</span>
          </div>

          {a.status !== "paid" && !a.buyerApproved && (
            <button type="button" disabled={busy} onClick={() => act({ action: "approve", agreementId: a.id, hash: a.termsHash })} className="mt-6 w-full bg-ink px-6 py-4 text-paper hover:bg-ink/85 disabled:opacity-30">
              I agree to these exact terms
            </button>
          )}
          {a.buyerApproved && !a.sellerApproved && <p className="mt-6 text-sm text-muted">Waiting for {makerName} to approve the same terms. This page updates by itself.</p>}
          {a.payable && (
            <button type="button" disabled={busy} onClick={() => act({ action: "checkout" })} className="mt-6 w-full bg-ink px-6 py-4 text-paper hover:bg-ink/85 disabled:opacity-30">
              Pay {usd(a.totalUsdCents)} with PayPal
            </button>
          )}
          {a.payable && a.holdUntil && <p className="mt-2 text-center text-xs text-muted">{makerName}&apos;s time is held for you until {new Date(a.holdUntil).toLocaleString()}.</p>}
          {a.status === "approved" && !a.payable && a.blockedBecause && <p className="mt-4 text-sm text-marigold">{a.blockedBecause}</p>}
        </section>
      )}

      {error && <p className="mt-6 text-sm text-danger">{error}</p>}

      {view.status !== "paid" && view.status !== "declined" && (
        <div className="mt-16 border-t border-line pt-10">
          <MessageThread makerName={makerName} customRequestId={requestId} title={`Questions for ${makerName}`} />
          <p className="mt-3 text-xs text-muted">Messages don&apos;t change the terms — any change becomes a new version you both approve.</p>
        </div>
      )}
    </div>
  );
}
