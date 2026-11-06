"use client";

import { useEffect, useState } from "react";
import { Wordmark } from "@/components/craft";
import { speak } from "@/lib/client/media";

type Facts = {
  makesProduct: boolean;
  piecesPerWeekday: number[];
  offDates: string[];
  materialsDays: number | null;
  materialsReadyDate: string | null;
  commitments: { ref: string; pieces: number; due: string | null }[];
  askInr: number;
  floorInr: number;
  maxPieces: number | null;
  prov: { source: "maker_confirmed" | "coordinator_entered"; at: string };
};
type Part = {
  id: string;
  orderRef: string;
  version: number;
  status: "pending" | "accepted" | "declined";
  inCurrentPlan: boolean;
  orderStatus: string | null;
  termsHash: string;
  requirementsReady: boolean;
  lines: [string, string][];
  readbackHi: string;
  pieces: number;
  payInr: number;
  respondedAt: string | null;
};
type View = { name: string; nameHi: string | null; collective: string; product: { en: string; hi: string }; facts: Facts; parts: Part[]; removed: { orderRef: string }[] };

const DAYS = ["रवि", "सोम", "मंगल", "बुध", "गुरु", "शुक्र", "शनि"];
const DAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hiDate = (iso: string) => new Date(iso).toLocaleDateString("hi-IN", { day: "numeric", month: "long", timeZone: "UTC" });
const field = "w-full border-b border-line bg-transparent py-2 text-base focus:border-ink focus:outline-none";

export function MakerHome({ token }: { token: string }) {
  const [view, setView] = useState<View | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [draft, setDraft] = useState<Facts | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const res = await fetch(`/api/m/${token}`).catch(() => null);
      if (cancelled || !res) return;
      if (res.status === 404) setMissing(true);
      else if (res.ok) setView(await res.json());
    };
    void tick();
    const t = setInterval(tick, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [token]);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/m/${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error);
      setView(out);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (missing)
    return (
      <Shell>
        <p lang="hi">यह लिंक काम नहीं कर रहा। संयोजक से नया लिंक माँगें।</p>
        <p className="mt-1 text-sm text-muted">This link isn&apos;t valid. Ask the coordinator for a new one.</p>
      </Shell>
    );
  if (!view) return <Shell>…</Shell>;
  // Unsaved edits, else her saved facts.
  const facts = draft ?? view.facts;

  const open = view.parts.filter((p) => p.inCurrentPlan && p.status !== "declined");
  const past = view.parts.filter((p) => !p.inCurrentPlan || p.status === "declined");
  const confirmed = view.facts.prov.source === "maker_confirmed";
  const set = (patch: Partial<Facts>) => {
    setSaved(false);
    setDraft({ ...facts, ...patch });
  };

  return (
    <Shell>
      <header>
        <p className="eyebrow deva">{view.collective}</p>
        <h1 className="mt-3 font-display text-4xl font-normal leading-tight" lang="hi">
          नमस्ते {view.nameHi ?? view.name}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted" lang="hi">
          यह पेज सिर्फ़ आपका है। इस लिंक से दिया गया जवाब आपका जवाब माना जाएगा, इसलिए इसे किसी और को न दें।
          <span className="mt-1 block text-xs">This page is yours. An answer given on this link counts as yours, so don&apos;t share it.</span>
        </p>
      </header>

      <section className="mt-12">
        <h2 className="font-display text-2xl" lang="hi">
          आपके हिस्से <span className="font-sans text-sm font-light text-muted">Your parts</span>
        </h2>
        {open.length === 0 && (
          <p className="mt-4 border border-dashed border-line bg-card px-5 py-8 text-center text-sm leading-relaxed text-muted" lang="hi">
            अभी कोई नया काम नहीं। जब संगठन कोई ऑर्डर बाँटेगा, आपका हिस्सा यहाँ आएगा।
            <span className="mt-1 block text-xs">Nothing new. When the collective shares out an order, your part appears here.</span>
          </p>
        )}
        <ul className="mt-5 space-y-6">
          {open.map((p) => (
            <li key={p.id} className="border border-line bg-card p-5 sm:p-6">
              <div className="flex items-baseline justify-between gap-3">
                <p className="eyebrow">Order {p.orderRef} · v{p.version}</p>
                <button type="button" onClick={() => speak(p.readbackHi, "hindi")} className="shrink-0 text-sm underline underline-offset-4" lang="hi">
                  🔊 सुनें
                </button>
              </div>
              <p className="mt-3 text-lg leading-relaxed" lang="hi">
                {p.readbackHi}
              </p>
              <dl className="mt-5 divide-y divide-line border-t border-line text-xs">
                {p.lines.map(([k, v]) => (
                  <div key={k} className="grid grid-cols-[6.5rem_1fr] gap-3 py-2">
                    <dt className="text-muted">{k}</dt>
                    <dd className="leading-relaxed">{v}</dd>
                  </div>
                ))}
              </dl>

              {p.status === "accepted" ? (
                <div className="mt-5 text-sm">
                  <p className="text-leaf" lang="hi">
                    ✓ आपने यह हिस्सा मंज़ूर किया{p.respondedAt ? ` (${hiDate(p.respondedAt)})` : ""}।
                    <span className="ml-1 text-xs text-muted">You accepted this part on this link.</span>
                  </p>
                  {p.orderStatus !== "paid" && p.orderStatus !== "paying" && (
                    <button type="button" disabled={busy} onClick={() => setDeclining(p.id)} className="mt-3 text-xs text-muted underline underline-offset-4 disabled:opacity-30" lang="hi">
                      अब नहीं कर पाएँगी? · Can no longer do it?
                    </button>
                  )}
                </div>
              ) : (
                <div className="mt-6 flex gap-3">
                  <button
                    type="button"
                    disabled={busy || !p.requirementsReady}
                    onClick={() => void post({ action: "respond", partId: p.id, hash: p.termsHash, answer: "accept" }).then((ok) => ok && speak("आपका हिस्सा मंज़ूर हो गया।", "hindi"))}
                    className="flex-1 bg-ink px-5 py-3 text-paper hover:bg-ink/85 disabled:opacity-30"
                    lang="hi"
                  >
                    हाँ, मंज़ूर <span className="text-xs opacity-70">Accept</span>
                  </button>
                  <button type="button" disabled={busy} onClick={() => setDeclining(p.id)} className="flex-1 border border-ink px-5 py-3 hover:bg-ink hover:text-paper disabled:opacity-30" lang="hi">
                    नहीं <span className="text-xs opacity-70">Decline</span>
                  </button>
                </div>
              )}

              {declining === p.id && (
                <form
                  className="mt-5 border-t border-line pt-5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void post({ action: "respond", partId: p.id, hash: p.termsHash, answer: "decline", note: reason.trim() || null }).then((ok) => {
                      if (ok) {
                        setDeclining(null);
                        setReason("");
                      }
                    });
                  }}
                >
                  <label className="block text-sm" lang="hi">
                    क्यों? (चाहें तो) <span className="text-xs text-muted">Why? (optional)</span>
                    <input value={reason} onChange={(e) => setReason(e.target.value)} className={field} lang="hi" />
                  </label>
                  <div className="mt-4 flex gap-5 text-sm">
                    <button type="submit" disabled={busy} className="text-danger underline underline-offset-4 disabled:opacity-30" lang="hi">
                      हाँ, मना करें · Decline
                    </button>
                    <button type="button" onClick={() => setDeclining(null)} className="text-muted underline underline-offset-4" lang="hi">
                      रहने दें · Cancel
                    </button>
                  </div>
                  <p className="mt-3 text-xs leading-relaxed text-muted">
                    The coordinator is told and plans again. Nobody takes your place without a new plan the buyer approves.
                  </p>
                </form>
              )}
            </li>
          ))}
        </ul>
        {(past.length > 0 || view.removed.length > 0) && (
          <ul className="mt-6 space-y-2 text-sm text-muted">
            {past.map((p) => (
              <li key={p.id} lang="hi">
                Order {p.orderRef}: {p.status === "declined" ? "आपने मना किया · you declined" : "यह ऑर्डर बदल गया · this order changed"}
              </li>
            ))}
            {view.removed.map((r) => (
              <li key={r.orderRef} lang="hi">
                Order {r.orderRef}: अब आपके हिस्से की ज़रूरत नहीं · your part is no longer needed
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-16 border-t border-line pt-10">
        <h2 className="font-display text-2xl" lang="hi">
          आपकी जानकारी <span className="font-sans text-sm font-light text-muted">Your facts</span>
        </h2>
        <p className={`mt-2 text-sm ${confirmed ? "text-leaf" : "text-marigold"}`} lang="hi">
          {confirmed ? `✓ आपने ${hiDate(view.facts.prov.at)} को पक्का किया` : "! संयोजक ने भरा है — जाँचकर पक्का करें"}
          <span className="ml-1 text-xs text-muted">{confirmed ? "Confirmed by you" : "Entered by the coordinator: please check and confirm"}</span>
        </p>
        <p className="mt-2 text-xs leading-relaxed text-muted" lang="hi">
          हाट इन्हीं से तय करता है कि आपको कितना काम, किस दिन दिया जा सकता है। कोई भी योजना इनसे बाहर नहीं जाती।
          <span className="block">Haat plans only within these; no plan goes beyond them.</span>
        </p>

        <form
          className="mt-8 space-y-8"
          onSubmit={(e) => {
            e.preventDefault();
            void post({ action: "facts", facts }).then((ok) => {
              if (ok) {
                setSaved(true);
                setDraft(null);
              }
            });
          }}
        >
          <label className="flex items-start gap-3 text-sm" lang="hi">
            <input type="checkbox" checked={facts.makesProduct} onChange={(e) => set({ makesProduct: e.target.checked })} className="mt-1" />
            <span>
              मैं {view.product.hi} बनाती हूँ <span className="block text-xs text-muted">I make {view.product.en}s</span>
            </span>
          </label>

          <fieldset>
            <legend className="text-sm" lang="hi">
              हर दिन कितने पीस बना सकती हैं? <span className="text-xs text-muted">Pieces per day</span>
            </legend>
            <div className="mt-3 grid grid-cols-7 gap-2">
              {DAYS.map((d, i) => (
                <label key={d} className="text-center text-xs" lang="hi">
                  {d}
                  <span className="sr-only"> {DAYS_EN[i]}</span>
                  <input
                    inputMode="numeric"
                    value={facts.piecesPerWeekday[i]}
                    onChange={(e) => set({ piecesPerWeekday: facts.piecesPerWeekday.map((x, j) => (j === i ? Number(e.target.value.replace(/\D/g, "") || 0) : x)) })}
                    className="mt-1 w-full border border-line bg-card py-2 text-center text-base focus:border-ink focus:outline-none"
                  />
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-6 sm:grid-cols-2">
            <label className="block text-sm" lang="hi">
              सामान किस तारीख़ को हाथ में होगा? <span className="text-xs text-muted">Materials in hand on (leave blank if unknown)</span>
              <input
                type="date"
                value={facts.materialsReadyDate ?? ""}
                placeholder="?"
                onChange={(e) => set({ materialsReadyDate: e.target.value || null })}
                className={field}
              />
            </label>
            <label className="block text-sm" lang="hi">
              एक ऑर्डर में ज़्यादा से ज़्यादा पीस <span className="text-xs text-muted">Most pieces per order (optional)</span>
              <input inputMode="numeric" value={facts.maxPieces ?? ""} onChange={(e) => set({ maxPieces: e.target.value === "" ? null : Number(e.target.value.replace(/\D/g, "")) })} className={field} />
            </label>
            <label className="block text-sm" lang="hi">
              हर पीस का आपका दाम (₹) <span className="text-xs text-muted">Your asking price per piece</span>
              <input inputMode="decimal" value={facts.askInr} onChange={(e) => set({ askInr: Number(e.target.value.replace(/[^0-9.]/g, "") || 0) })} className={field} />
            </label>
            <label className="block text-sm" lang="hi">
              इससे कम में नहीं (₹) — सिर्फ़ आपके लिए <span className="text-xs text-muted">Your minimum; never shown to buyers</span>
              <input inputMode="decimal" value={facts.floorInr} onChange={(e) => set({ floorInr: Number(e.target.value.replace(/[^0-9.]/g, "") || 0) })} className={field} />
            </label>
          </div>

          <fieldset>
            <legend className="text-sm" lang="hi">
              दूसरे वादे <span className="text-xs text-muted">Other work you&apos;ve promised</span>
            </legend>
            <ul className="mt-2 space-y-3">
              {facts.commitments.map((c, i) => (
                <li key={i} className="grid grid-cols-[1fr_auto] items-end gap-x-4 gap-y-2 text-sm sm:flex sm:flex-wrap">
                  <input value={c.ref} placeholder="किसका / for whom" onChange={(e) => set({ commitments: facts.commitments.map((x, j) => (j === i ? { ...x, ref: e.target.value } : x)) })} className="min-w-0 flex-1 border-b border-line bg-transparent py-2 focus:border-ink focus:outline-none" aria-label="What" />
                  <label lang="hi" className="flex items-center gap-2">
                    पीस
                    <input inputMode="numeric" value={c.pieces} onChange={(e) => set({ commitments: facts.commitments.map((x, j) => (j === i ? { ...x, pieces: Number(e.target.value.replace(/\D/g, "") || 0) } : x)) })} className="w-14 border-b border-line bg-transparent py-2 text-center focus:border-ink focus:outline-none" />
                  </label>
                  <label lang="hi" className="flex items-center gap-2">
                    कब तक
                    <input type="date" value={c.due ?? ""} onChange={(e) => set({ commitments: facts.commitments.map((x, j) => (j === i ? { ...x, due: e.target.value || null } : x)) })} className="border-b border-line bg-transparent py-1.5 focus:border-ink focus:outline-none" />
                  </label>
                  <button type="button" onClick={() => set({ commitments: facts.commitments.filter((_, j) => j !== i) })} className="text-xs text-muted underline underline-offset-4" lang="hi">
                    हटाएँ
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" onClick={() => set({ commitments: [...facts.commitments, { ref: "", pieces: 1, due: null }] })} className="mt-3 text-sm underline underline-offset-4" lang="hi">
              + वादा जोड़ें <span className="text-xs text-muted">Add one</span>
            </button>
          </fieldset>

          <div className="flex flex-wrap items-center gap-4">
            <button type="submit" disabled={busy} className="bg-ink px-6 py-3 text-paper hover:bg-ink/85 disabled:opacity-30" lang="hi">
              यह सही है, पक्का करें <span className="text-xs opacity-70">Confirm</span>
            </button>
            {saved && (
              <span className="text-sm text-leaf" lang="hi">
                ✓ पक्का हो गया
              </span>
            )}
          </div>
        </form>
      </section>

      {error && (
        <p className="mt-8 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-24 pt-8 sm:px-6">
      <nav className="mb-10 border-b border-line pb-5">
        <Wordmark />
      </nav>
      {children}
    </div>
  );
}
