"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { EmptyState, SectionHeading, SellerNav, STUDIO, StudioHeader } from "@/components/seller-nav";
import { speak } from "@/lib/client/media";

type Words = { en: string; hi: string };
type Member = {
  id: string;
  name: string;
  nameHi: string | null;
  facts: { piecesPerWeekday: number[]; materialsDays: number | null; materialsReadyDate: string | null; commitments: { pieces: number }[]; askInr: number; maxPieces: number | null; makesProduct: boolean; prov: { source: string; at: string } };
};
type OrderItem = { id: string; status: string; buyerName: string | null; spec: { quantity: number; deadline: string }; createdAt: string };
type Home = { collective: { name: string; coordinatorName: string; settings: { product: { en: string; hi: string } } }; members: Member[]; orders: OrderItem[] };
type Part = { memberId: string; name: string; partId: string; version: number; status: string; respondedAt: string | null; via: string | null; note: string | null; pieces: number; payInr: number; reused: boolean };
type Detail = {
  id: string;
  status: string;
  buyerName: string | null;
  buyerText: string;
  spec: { quantity: number; deadline: string; budgetUsdCents: number | null; details: string | null; detailsHi?: string | null };
  collective: { name: string; product: { en: string; hi: string } };
  excluded: string[];
  evaluation: { kind: string; checked: boolean; problems: string[]; headline: Words; reasons: Words[]; alternatives: (Words & { choice: string })[]; notes: Words[] };
  plan: {
    id: string;
    version: number;
    choice: string;
    status: string;
    statusNote: string | null;
    certified: boolean;
    termsHash: string;
    holdUntil: string | null;
    buyerLines: [string, string][];
    parts: Part[];
    schedule: { dates: string[]; rows: { name: string; pieces: number[] }[]; finishing: { date: string; pieces: number }[] };
    money: { makersInr: number; finishingInr: number; packagingInr: number; collectionInr: number; chargeInr: number; shippingInr: number; totalCostInr: number; priceUsdCents: number; estFeeUsdCents: number };
    payment: { paypalOrderId: string; captureId: string | null; status: string; amountCents: number; feeCents: number | null; netCents: number | null; refundedCents: number; capturedAt: string | null } | null;
    shares: ShareRowData[];
  } | null;
  history: { id: string; version: number; choice: string; status: string; createdAt: string }[];
};

type MakerPayment = { id: string; amountPaise: number; method: "upi" | "bank"; reference: string; reportedBy: string; reportedAt: string; status: "reported" | "confirmed" | "disputed" | "withdrawn"; respondedAt: string | null; note: string | null };
type ShareRowData = { shareId: string; memberId: string; name: string; owedPaise: number; confirmedPaise: number; awaitingPaise: number; disputedPaise: number; leftPaise: number; settled: boolean; payments: MakerPayment[] };

const ORDER_HI: Record<string, string> = { new: "नया", offered: "भेजा", approved: "मंज़ूर", paying: "भुगतान", paid: "पैसे मिले", declined: "मना", cancelled: "रद्द" };
const PLAN: Record<string, Words> = {
  awaiting_makers: { hi: "कारीगरों की हाँ बाकी", en: "Waiting for makers" },
  ready: { hi: "ख़रीदार की मंज़ूरी बाकी", en: "Waiting for the buyer" },
  maker_declined: { hi: "किसी ने मना किया", en: "A maker said no" },
  approved: { hi: "मंज़ूर, समय रोका गया", en: "Approved; capacity held" },
  needs_replan: { hi: "फिर से योजना बनानी है", en: "Needs a new plan" },
  paying: { hi: "भुगतान चल रहा है", en: "Payment in progress" },
  paid: { hi: "पैसे मिले", en: "Paid" },
  superseded: { hi: "नया रूप भेजा गया", en: "Replaced" },
  cancelled: { hi: "रद्द", en: "Cancelled" },
};
const DAYS = ["रवि", "सोम", "मंगल", "बुध", "गुरु", "शुक्र", "शनि"];
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const paise = (n: number) => `₹${(n / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const short = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const field = "w-full border-b border-line bg-transparent py-2 text-sm focus:border-ink focus:outline-none";

export function Collective() {
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get("o");
  const [home, setHome] = useState<Home | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ buyerName: "", buyerText: "", quantity: "", deadline: "", budgetUsd: "", details: "", detailsHi: "" });
  const [showForm, setShowForm] = useState(false);

  const loadHome = useCallback(async () => {
    const res = await fetch("/api/seller/collective").catch(() => null);
    if (res?.ok) setHome(await res.json());
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const res = await fetch("/api/seller/collective").catch(() => null);
      if (!cancelled && res?.ok) setHome(await res.json());
    };
    void tick();
    const t = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    const tick = async () => {
      const res = await fetch(`/api/seller/collective/orders/${selected}`).catch(() => null);
      if (!cancelled && res?.ok) setDetail(await res.json());
    };
    void tick();
    const t = setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [selected]);

  async function call(url: string, body: Record<string, unknown>) {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error);
      return out;
    } catch (e) {
      setNote((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function createOrder(e: React.FormEvent) {
    e.preventDefault();
    const out = await call("/api/seller/collective", { action: "order", ...form, quantity: Number(form.quantity) });
    if (!out) return;
    setForm({ buyerName: "", buyerText: "", quantity: "", deadline: "", budgetUsd: "", details: "", detailsHi: "" });
    setShowForm(false);
    await loadHome();
    open(out.id);
  }

  async function orderAction(body: Record<string, unknown>) {
    if (!selected) return;
    const out = await call(`/api/seller/collective/orders/${selected}`, body);
    if (out) setDetail(out);
    void loadHome();
  }

  async function newLink(memberId: string) {
    const out = await call("/api/seller/collective", { action: "link", memberId });
    if (out) setLinks((l) => ({ ...l, [memberId]: `${window.location.origin}${out.path}` }));
  }

  function open(id: string) {
    setDetail(null);
    setNote(null);
    router.replace(`/seller/collective?o=${id}`);
  }

  const product = home?.collective.settings.product;

  return (
    <div className={STUDIO}>
      <SellerNav active="collective" />
      <StudioHeader hi="समूह के ऑर्डर" en="Collective orders">
        <p lang="hi">
          जो ऑर्डर कोई अकेले नहीं ले सकती, वह सब मिलकर — हर किसी के दाम, समय और हाँ के साथ। हाट हर योजना की अलग से जाँच करता है।
          <span className="block text-xs">Orders no maker can take alone, shared out within each maker&apos;s price, time and consent. Every plan is checked independently.</span>
        </p>
      </StudioHeader>

      <div className="lg:grid lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start lg:gap-14 xl:grid-cols-[minmax(0,25rem)_minmax(0,1fr)] xl:gap-16">
        <div className={selected ? "hidden lg:block" : ""}>
          <SectionHeading
            hi="ऑर्डर"
            en="Orders"
            action={
              <button type="button" onClick={() => setShowForm((x) => !x)} className="text-sm underline underline-offset-4" lang="hi">
                {showForm ? "रहने दें" : "+ नया"} <span className="text-xs text-muted">{showForm ? "Cancel" : "New"}</span>
              </button>
            }
          />
          {showForm && (
            <form onSubmit={createOrder} className="mb-8 space-y-4 border border-line bg-card p-5">
              <label className="block text-xs text-muted">
                Buyer
                <input value={form.buyerName} onChange={(e) => setForm({ ...form, buyerName: e.target.value })} className={field} />
              </label>
              <label className="block text-xs text-muted">
                What they asked for
                <textarea value={form.buyerText} onChange={(e) => setForm({ ...form, buyerText: e.target.value })} rows={2} className={field} />
              </label>
              <div className="grid grid-cols-2 gap-4">
                <label className="block text-xs text-muted">
                  Pieces
                  <input inputMode="numeric" required value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value.replace(/\D/g, "") })} className={field} />
                </label>
                <label className="block text-xs text-muted">
                  Delivered by
                  <input type="date" required value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} className={field} />
                </label>
                <label className="block text-xs text-muted">
                  Budget, USD (optional)
                  <input inputMode="decimal" value={form.budgetUsd} onChange={(e) => setForm({ ...form, budgetUsd: e.target.value.replace(/[^0-9.]/g, "") })} className={field} />
                </label>
                <label className="block text-xs text-muted">
                  Details (colour, size)
                  <input maxLength={300} value={form.details} onChange={(e) => setForm({ ...form, details: e.target.value })} className={field} />
                </label>
                <label className="col-span-2 block text-xs text-muted">
                  वही शर्तें हिंदी में · The same requirements in Hindi
                  <textarea lang="hi" required={!!form.details.trim()} maxLength={600} value={form.detailsHi} onChange={(e) => setForm({ ...form, detailsHi: e.target.value })} className={field} />
                  <span className="mt-1 block">Review both readings. The maker hears this Hindi text before accepting.</span>
                </label>
              </div>
              <button type="submit" disabled={busy || !form.quantity || !form.deadline} className="bg-ink px-5 py-2.5 text-sm text-paper hover:bg-ink/85 disabled:opacity-30">
                Record request{product ? ` for ${product.en}s` : ""}
              </button>
            </form>
          )}

          {home === null ? (
            <p className="text-muted">…</p>
          ) : home.orders.length === 0 ? (
            <EmptyState hi="अभी कोई ऑर्डर नहीं" en="No collective orders yet" detailHi="किसी ख़रीदार का बड़ा ऑर्डर यहाँ दर्ज करें; हाट देखेगा कि सब मिलकर क्या कर सकती हैं।" detailEn="Record a buyer's bulk request here; Haat works out what the makers can do together." />
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {home.orders.map((o) => (
                <li key={o.id}>
                  <button type="button" onClick={() => open(o.id)} className={`flex w-full items-start justify-between gap-4 py-4 text-left ${selected === o.id ? "text-ink" : "text-ink/80 hover:text-ink"}`}>
                    <span className={selected === o.id ? "font-medium" : ""}>
                      {o.spec.quantity} × {product?.en ?? "pieces"}
                      <span className="block text-xs text-muted">
                        {o.buyerName ?? "Buyer"} · by {short(o.spec.deadline)}
                      </span>
                    </span>
                    <span className="eyebrow deva shrink-0">{ORDER_HI[o.status] ?? o.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <SectionHeading hi="कारीगर" en="Makers" className="mt-12" />
          <ul className="space-y-4">
            {home?.members.map((m) => {
              const f = m.facts;
              const confirmed = f.prov.source === "maker_confirmed";
              return (
                <li key={m.id} className="border border-line bg-card p-4 text-sm">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="font-medium">
                      <span lang="hi">{m.nameHi ?? m.name}</span> <span className="text-xs font-normal text-muted">{m.name}</span>
                    </p>
                    <span className={`text-xs ${confirmed ? "text-leaf" : "text-marigold"}`}>{confirmed ? `✓ confirmed ${short(f.prov.at)}` : "! estimate"}</span>
                  </div>
                  <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-muted" aria-label="Pieces per weekday, Sunday first">
                    {f.piecesPerWeekday.map((x, i) => (
                      <span key={i}>
                        <span lang="hi">{DAYS[i]}</span> <span className={x ? "text-ink" : ""}>{x}</span>
                      </span>
                    ))}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-muted">
                    {inr(f.askInr)} a piece · materials {f.materialsReadyDate === null ? "unknown" : `ready ${short(f.materialsReadyDate)}`}
                    {f.commitments.length > 0 && ` · ${f.commitments.reduce((s, c) => s + c.pieces, 0)} promised elsewhere`}
                    {f.maxPieces !== null && ` · at most ${f.maxPieces}`}
                    {!f.makesProduct && " · doesn't make this"}
                  </p>
                  {links[m.id] ? (
                    <div className="mt-3 bg-paper-deep/60 p-3 text-xs">
                      <p className="break-all font-mono">{links[m.id]}</p>
                      <p className="mt-1 text-muted">Shown once. Send it to her yourself; her old link no longer works.</p>
                      <button type="button" onClick={() => void navigator.clipboard?.writeText(links[m.id])} className="mt-2 underline underline-offset-4">
                        Copy
                      </button>
                    </div>
                  ) : (
                    <button type="button" disabled={busy} onClick={() => newLink(m.id)} className="mt-3 text-xs underline underline-offset-4 disabled:opacity-30">
                      New personal link
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        {selected && detail ? (
          <OrderDetail key={detail.id} detail={detail} busy={busy} onAction={orderAction} onBack={() => router.replace("/seller/collective")} />
        ) : selected ? (
          <p className="text-muted">…</p>
        ) : null}
      </div>
      {note && (
        <p className="mt-6 text-sm text-danger" role="alert">
          {note}
        </p>
      )}
    </div>
  );
}

const PAYMENT_EN: Record<MakerPayment["status"], string> = { reported: "○ waiting for her to confirm", confirmed: "✓ she confirmed receiving it", disputed: "✗ she says it didn't arrive", withdrawn: "withdrawn" };

/** The buyer's PayPal payment (PayPal's own numbers) and what the collective owes and has paid each maker. */
function PaymentSection({ plan: p, busy, onAction }: { plan: NonNullable<Detail["plan"]>; busy: boolean; onAction: (b: Record<string, unknown>) => void }) {
  const pay = p.payment;
  const refunded = pay && ["REFUNDED", "PARTIALLY_REFUNDED", "REVERSED"].includes(pay.status);
  return (
    <div className="mt-8 border-t border-line pt-6">
      <SectionHeading hi="भुगतान" en="Payment" className="mb-2" />
      {pay && (
        <>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted">Buyer paid the collective</dt>
              <dd className="font-medium">{p.status === "paid" ? usd(pay.amountCents) : "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">PayPal fee</dt>
              <dd>
                {pay.feeCents !== null ? usd(pay.feeCents) : "—"} <span className="text-xs text-muted">est. {usd(p.money.estFeeUsdCents)}</span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Collective receives</dt>
              <dd>{pay.netCents !== null ? usd(pay.netCents) : "—"}</dd>
            </div>
          </dl>
          <p className="mt-2 break-all text-xs text-muted">
            PayPal order <span className="font-mono">{pay.paypalOrderId}</span>
            {pay.captureId && (
              <>
                {" "}
                · capture <span className="font-mono">{pay.captureId}</span>
              </>
            )}
            {pay.capturedAt && <> · {when(pay.capturedAt)}</>} · {pay.status.toLowerCase().replace(/_/g, " ")}
          </p>
          {refunded && (
            <p className="mt-2 text-xs text-marigold">
              PayPal reports this payment as {pay.status.toLowerCase().replace(/_/g, " ")}. Changes after payment aren&apos;t handled in this version; the makers&apos; shares below are unchanged.
            </p>
          )}
        </>
      )}
      {p.shares.length > 0 && (
        <>
          <p className="mt-6 text-sm">
            <span lang="hi">कारीगरों का हिस्सा</span> <span className="text-xs text-muted">· Makers&apos; shares, owed from the buyer&apos;s payment</span>
          </p>
          <ul className="mt-3 space-y-5">
            {p.shares.map((sh) => (
              <ShareRow key={sh.shareId} share={sh} busy={busy} onAction={onAction} />
            ))}
          </ul>
          <p className="mt-4 text-xs leading-relaxed text-muted">
            Reported is not paid: only the maker can confirm a payment reached her, on her own link. Haat doesn&apos;t see bank or UPI records. A record she hasn&apos;t confirmed can be withdrawn.
          </p>
        </>
      )}
    </div>
  );
}

function ShareRow({ share: sh, busy, onAction }: { share: ShareRowData; busy: boolean; onAction: (b: Record<string, unknown>) => void }) {
  const [form, setForm] = useState({ amount: "", method: "upi" as "upi" | "bank", reference: "" });
  const shown = sh.payments.filter((x) => x.status !== "withdrawn");
  return (
    <li className="border border-line bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p>
          {sh.name} <span className="text-xs text-muted">· owed {paise(sh.owedPaise)}</span>
        </p>
        <p className={`text-xs ${sh.settled ? "text-leaf" : "text-muted"}`}>
          {sh.settled ? "✓ settled: she confirmed every rupee" : `she confirmed ${paise(sh.confirmedPaise)} of ${paise(sh.owedPaise)}`}
        </p>
      </div>
      {shown.length > 0 && (
        <ul className="mt-3 divide-y divide-line border-t border-line text-xs">
          {shown.map((x) => (
            <li key={x.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
              <span>
                {paise(x.amountPaise)} · {x.method === "upi" ? "UPI" : "bank"} <span className="break-all font-mono">{x.reference}</span>
                <span className="text-muted"> · {when(x.reportedAt)}</span>
                {x.note && <span className="block text-muted">“{x.note}”</span>}
              </span>
              <span className={x.status === "confirmed" ? "text-leaf" : x.status === "disputed" ? "text-danger" : "text-muted"}>
                {PAYMENT_EN[x.status]}
                {x.status !== "confirmed" && (
                  <button type="button" disabled={busy} onClick={() => onAction({ action: "withdraw_payment", paymentId: x.id })} className="ml-3 text-ink underline underline-offset-4 disabled:opacity-30">
                    Withdraw
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {sh.leftPaise > 0 && (
        <form
          className="mt-3 grid grid-cols-2 items-end gap-x-4 gap-y-3 border-t border-line pt-3 text-xs sm:grid-cols-[7rem_6rem_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            onAction({ action: "report_payment", shareId: sh.shareId, amountInr: form.amount || sh.leftPaise / 100, method: form.method, reference: form.reference });
            setForm({ ...form, amount: "", reference: "" });
          }}
        >
          <label className="text-muted">
            Amount (₹)
            <input inputMode="decimal" placeholder={String(sh.leftPaise / 100)} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value.replace(/[^0-9.]/g, "") })} className={field} />
          </label>
          <label className="text-muted">
            Sent by
            <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value as "upi" | "bank" })} className={field}>
              <option value="upi">UPI</option>
              <option value="bank">Bank</option>
            </select>
          </label>
          <label className="col-span-2 text-muted sm:col-span-1">
            {form.method === "upi" ? "UPI reference (12 digits)" : "Bank UTR"}
            <input required value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} className={`${field} font-mono`} />
          </label>
          <button type="submit" disabled={busy} className="col-span-2 border border-ink px-4 py-2 hover:bg-ink hover:text-paper disabled:opacity-30 sm:col-span-1">
            Record payment
          </button>
        </form>
      )}
    </li>
  );
}

function OrderDetail({ detail: d, busy, onAction, onBack }: { detail: Detail; busy: boolean; onAction: (b: Record<string, unknown>) => void; onBack: () => void }) {
  const ev = d.evaluation;
  const p = d.plan;
  const open = p && !["paid", "paying"].includes(p.status);
  const [copied, setCopied] = useState(false);
  const [readings, setReadings] = useState({ details: d.spec.details ?? "", detailsHi: d.spec.detailsHi ?? "" });
  const readingsChanged = readings.details.trim() !== (d.spec.details ?? "") || readings.detailsHi.trim() !== (d.spec.detailsHi ?? "");
  const buyerUrl = typeof window === "undefined" ? `/c/orders/${d.id}` : `${window.location.origin}/c/orders/${d.id}`;

  return (
    <article>
      <button type="button" onClick={onBack} className="mb-5 text-sm text-muted underline underline-offset-4 hover:text-ink lg:hidden">
        ← <span lang="hi">सभी ऑर्डर</span> · All orders
      </button>
      <section className="border border-line bg-card p-5 sm:p-6">
        <p className="eyebrow">{d.buyerName ?? "Buyer"}</p>
        <p className="mt-2 font-display text-2xl leading-tight">
          {d.spec.quantity} × {d.collective.product.en}
          {d.spec.details && <span className="text-lg text-muted">, {d.spec.details}</span>}
        </p>
        <p className="mt-1 text-sm text-muted">
          Delivered by {short(d.spec.deadline)}
          {d.spec.budgetUsdCents !== null && ` · budget ${usd(d.spec.budgetUsdCents)}`}
        </p>
        {d.buyerText && <p className="mt-3 text-xs italic text-muted">“{d.buyerText}”</p>}
        {open !== false && (
          <form className="mt-5 space-y-3 border-t border-line pt-4" onSubmit={(e) => { e.preventDefault(); onAction({ action: "requirements", ...readings }); }}>
            <label className="block text-xs text-muted">Requirements in English
              <textarea maxLength={300} value={readings.details} onChange={(e) => setReadings({ ...readings, details: e.target.value })} className={field} />
            </label>
            <label className="block text-xs text-muted">वही शर्तें हिंदी में · The same requirements in Hindi
              <textarea lang="hi" required={!!readings.details.trim()} maxLength={600} value={readings.detailsHi} onChange={(e) => setReadings({ ...readings, detailsHi: e.target.value })} className={field} />
            </label>
            <p className="text-xs text-muted">Review and save both readings before sending. Changes release unpaid reservations and require a new plan and renewed maker consent.</p>
            <button type="submit" disabled={busy} className="text-xs underline underline-offset-4 disabled:opacity-30">Save bilingual requirements</button>
          </form>
        )}
      </section>

      {open !== false && (
        <section className="mt-10">
          <SectionHeading
            hi="हाट की जाँच"
            en="Today's facts, checked"
            className="mb-2"
            action={
              <span className={`whitespace-nowrap text-xs ${ev.checked ? "text-leaf" : ev.kind === "unresolved" ? "text-marigold" : "text-danger"}`}>
                {ev.checked ? "✓ independently checked" : ev.kind === "unresolved" ? "not decided" : "✗ checker rejected"}
              </span>
            }
          />
          <p className="text-lg leading-relaxed" lang="hi">
            {ev.headline.hi}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-muted">{ev.headline.en}</p>
          {ev.reasons.length > 0 && (
            <ul className="mt-4 space-y-3 text-sm">
              {ev.reasons.map((r) => (
                <li key={r.en} className="leading-relaxed" lang="hi">
                  {r.hi} <span className="mt-0.5 block text-xs leading-normal text-muted">{r.en}</span>
                </li>
              ))}
            </ul>
          )}
          {ev.notes.length > 0 && (
            <ul className="mt-4 space-y-2 text-xs text-marigold">
              {ev.notes.map((n) => (
                <li key={n.en} className="leading-relaxed">
                  ! {n.en}
                </li>
              ))}
            </ul>
          )}
          {ev.problems.length > 0 && <p className="mt-3 text-xs text-danger">Checker: {ev.problems.join("; ")}</p>}
          <button type="button" onClick={() => speak([ev.headline.hi, ...ev.reasons.map((r) => r.hi)].join(" "), "hindi")} className="mt-3 text-xs underline underline-offset-4">
            🔊 सुनें
          </button>

          {ev.checked && ev.alternatives.length > 0 && (
            <div className="mt-6 space-y-3">
              {ev.alternatives.map((a) => (
                <div key={a.choice} className="flex flex-wrap items-center justify-between gap-3 border border-line bg-card px-4 py-3 text-sm">
                  <span>
                    <span lang="hi">{a.hi}</span>
                    <span className="block text-xs text-muted">{a.en}</span>
                  </span>
                  <button type="button" disabled={busy || readingsChanged || (!!d.spec.details && !d.spec.detailsHi)} onClick={() => onAction({ action: "offer", choice: a.choice })} className="border border-ink px-4 py-2 text-xs hover:bg-ink hover:text-paper disabled:opacity-30">
                    {p ? "Send as new version" : "Send to makers"}
                  </button>
                </div>
              ))}
              <p className="text-xs leading-relaxed text-muted">
                Each maker gets only her own part, on her own link. Makers whose part is unchanged keep their answer.
                {p?.status === "approved" && " Sending a new version releases the capacity held for the current one; the buyer approves again."}
              </p>
            </div>
          )}
        </section>
      )}

      {p && (
        <section className="mt-12">
          <SectionHeading hi={`योजना v${p.version}`} en={PLAN[p.status]?.en ?? p.status} className="mb-2" action={<span className="text-xs text-muted">{p.certified ? "cheapest: certified" : "cheapest: not certified"}</span>} />
          <p className="text-sm" lang="hi">
            {PLAN[p.status]?.hi}
            {p.status === "approved" && p.holdUntil && <span className="text-xs text-muted"> · held until {when(p.holdUntil)}</span>}
          </p>
          {p.statusNote && <p className="mt-1 text-xs text-marigold">{p.statusNote}</p>}

          <ul className="mt-5 divide-y divide-line border-y border-line text-sm">
            {p.parts.map((x) => (
              <li key={x.partId} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-3">
                <span>
                  {x.name} <span className="text-xs text-muted">· {x.pieces} pieces · {inr(x.payInr)} · v{x.version}</span>
                  {x.note && <span className="block text-xs text-muted">“{x.note}”</span>}
                </span>
                <span className={`text-xs ${x.status === "accepted" ? "text-leaf" : x.status === "declined" ? "text-danger" : "text-muted"}`}>
                  {x.status === "accepted" ? `✓ accepted on her link${x.reused ? " (unchanged part)" : ""}` : x.status === "declined" ? "✗ said no" : "○ waiting for her"}
                  {x.status === "declined" && !d.excluded.includes(x.name) && (
                    <button type="button" disabled={busy} onClick={() => onAction({ action: "exclude", memberId: x.memberId })} className="ml-3 text-ink underline underline-offset-4 disabled:opacity-30">
                      Leave her out of the next plan
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {d.excluded.length > 0 && <p className="mt-2 text-xs text-muted">Left out after saying no: {d.excluded.join(", ")}</p>}

          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-max border-collapse text-xs tabular-nums">
              <thead>
                <tr className="text-muted">
                  <th className="py-2 pr-4 text-left font-normal">Pieces made</th>
                  {p.schedule.dates.map((x) => (
                    <th key={x} className="px-1.5 py-2 text-right font-normal">
                      {short(x)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {p.schedule.rows.map((r) => (
                  <tr key={r.name} className="border-t border-line">
                    <td className="py-2 pr-4">{r.name}</td>
                    {r.pieces.map((n, i) => (
                      <td key={i} className={`px-1.5 py-2 text-right ${n ? "" : "text-line"}`}>
                        {n || "·"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            Finishing: {p.schedule.finishing.map((f) => `${short(f.date)} ${f.pieces}`).join(" · ")}
          </p>

          <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            {(
              [
                ["Makers' pay", inr(p.money.makersInr)],
                ["Finishing", inr(p.money.finishingInr)],
                ["Packaging", inr(p.money.packagingInr)],
                ["Collection", inr(p.money.collectionInr)],
                ["Collective's charge", inr(p.money.chargeInr)],
                ["Shipping", inr(p.money.shippingInr)],
                ["Total cost", inr(p.money.totalCostInr)],
                ["Buyer pays", usd(p.money.priceUsdCents)],
                ["PayPal fee (est.)", usd(p.money.estFeeUsdCents)],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-muted">{k}</dt>
                <dd className={k === "Buyer pays" ? "font-medium" : ""}>{v}</dd>
              </div>
            ))}
          </dl>

          {(p.payment || p.shares.length > 0) && <PaymentSection plan={p} busy={busy} onAction={onAction} />}

          <div className="mt-8 border-t border-line pt-6">
            <p className="eyebrow">What the buyer sees</p>
            <dl className="mt-3 divide-y divide-line text-sm">
              {p.buyerLines.map(([k, v]) => (
                <div key={k} className="grid grid-cols-[8rem_1fr] gap-4 py-2 sm:grid-cols-[10rem_1fr]">
                  <dt className="text-muted">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
              <span className="break-all font-mono text-muted">{buyerUrl}</span>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(buyerUrl);
                  setCopied(true);
                }}
                className="underline underline-offset-4"
              >
                {copied ? "Copied" : "Copy buyer link"}
              </button>
            </div>
          </div>
        </section>
      )}

      <details className="mt-8 text-xs text-muted">
        <summary className="cursor-pointer">Role-play evaluation</summary>
        <p className="mt-2">Save the facts for both comparison rounds before making changes. This file contains private maker information; keep it with the observer.</p>
        <a href={`/api/seller/collective/orders/${d.id}?export=evaluation`} className="mt-2 inline-block underline underline-offset-4">Download evaluation facts</a>
      </details>

      {d.history.length > 1 && (
        <section className="mt-12">
          <SectionHeading hi="पुराने रूप" en="Versions" className="mb-2" />
          <ul className="space-y-1 text-xs text-muted">
            {d.history.map((h) => (
              <li key={h.id}>
                v{h.version} · {h.choice.replace(/_/g, " ")} · {PLAN[h.status]?.en ?? h.status} · {when(h.createdAt)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
