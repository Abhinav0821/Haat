"use client";

import { useEffect, useRef, useState } from "react";
import { SellerNav, STUDIO, StudioHeader } from "@/components/seller-nav";
import { speak, startRecording, type Recorder } from "@/lib/client/media";
import { computeEarnings, earningsSentenceEn, earningsSentenceHi, type Economics } from "@/lib/economics";

const EMPTY: Economics = {
  materialsInr: null,
  packagingInr: null,
  otherInr: 0,
  shippingCostInr: null,
  shippingChargeUsdCents: 0,
  minimumInr: null,
  piecesPerWeek: null,
  backlogPieces: 0,
  shippingDays: 10,
  askBeforeChanges: true,
  feePercent: 5.4,
  feeFixedUsdCents: 30,
};

type Field = { key: keyof Economics; hi: string; en: string; unit: "₹" | "$" | "#" | "%"; cents?: boolean };
const FIELDS: Field[] = [
  { key: "materialsInr", hi: "सामान का खर्च (हर पीस)", en: "Materials per piece", unit: "₹" },
  { key: "packagingInr", hi: "पैकिंग (हर पीस)", en: "Packaging per piece", unit: "₹" },
  { key: "otherInr", hi: "दूसरे खर्च (हर पीस)", en: "Other costs per piece", unit: "₹" },
  { key: "shippingCostInr", hi: "भेजने का आपका खर्च (हर पार्सल)", en: "Your courier cost per parcel", unit: "₹" },
  { key: "shippingChargeUsdCents", hi: "ग्राहक से शिपिंग", en: "Shipping charged to buyer", unit: "$", cents: true },
  { key: "minimumInr", hi: "कम से कम कमाई (हर पीस)", en: "Minimum left for your work, per piece", unit: "₹" },
  { key: "piecesPerWeek", hi: "हफ़्ते में कितने पीस", en: "Pieces per week", unit: "#" },
  { key: "backlogPieces", hi: "अभी कितने पीस का काम बाकी है", en: "Pieces already promised to others", unit: "#" },
  { key: "shippingDays", hi: "पार्सल कितने दिन में पहुँचता है", en: "Courier days to buyer", unit: "#" },
  { key: "feePercent", hi: "PayPal फ़ीस का अनुमान", en: "PayPal fee estimate", unit: "%" },
];

export function Rules() {
  const [rules, setRules] = useState<Economics>(EMPTY);
  const [inrPerUsd, setInrPerUsd] = useState(88);
  const [readback, setReadback] = useState<string | null>(null);
  const [heard, setHeard] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [examplePrice, setExamplePrice] = useState("30");
  const [typedRules, setTypedRules] = useState("");
  const recorder = useRef<Recorder | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/seller/rules").catch(() => null);
      if (!cancelled && res?.ok) {
        const body = await res.json();
        if (body.economics) setRules(body.economics);
        setInrPerUsd(body.inrPerUsd);
        if (body.readback) setReadback(body.readback.text);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function draftFrom(input: { audio?: Blob; text?: string }) {
    setBusy(true);
    setNote(null);
    const form = new FormData();
    if (input.audio) form.append("audio", input.audio, "rules.wav");
    if (input.text) form.append("text", input.text);
    try {
      const res = await fetch("/api/seller/rules/draft", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setRules(body.draft);
      setHeard(body.heard);
      setReadback(body.readback.text);
      setDirty(true);
      speak(body.readback.text, "hindi");
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleMic() {
    if (recording) {
      const r = recorder.current;
      recorder.current = null;
      setRecording(false);
      if (r) await draftFrom({ audio: await r.stop() });
      return;
    }
    try {
      recorder.current = await startRecording();
      setRecording(true);
    } catch {
      setNote("माइक्रोफ़ोन की अनुमति दें · Allow microphone access");
    }
  }

  async function approve() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/seller/rules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ economics: rules }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setDirty(false);
      setReadback(body.readback.text);
      speak("आपके नियम सेव हो गए।", "hindi");
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function setField(f: Field, raw: string) {
    const n = raw.trim() === "" ? null : Number(raw);
    if (n !== null && !Number.isFinite(n)) return;
    setRules((r) => ({ ...r, [f.key]: n === null ? (f.key === "otherInr" || f.key === "shippingChargeUsdCents" || f.key === "backlogPieces" ? 0 : null) : f.cents ? Math.round(n * 100) : n }));
    setDirty(true);
  }

  const example = computeEarnings(rules, { unitPriceUsdCents: Math.round((parseFloat(examplePrice) || 0) * 100), pieces: 1, inrPerUsd });

  return (
    <div className={STUDIO}>
      <SellerNav active="rules" />
      <StudioHeader hi="मेरे नियम" en="My costs & rules">
        <p>
          अपने खर्च और शर्तें बोलकर या लिखकर बताइए। हाट हर दाम और हर ऑर्डर इन्हीं से जाँचेगा।
          <span className="block text-xs">Say or type your costs and conditions. Haat checks every price and order against them — they only apply after you approve.</span>
        </p>
      </StudioHeader>

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:items-start lg:gap-14 xl:grid-cols-[minmax(0,1fr)_minmax(0,27rem)] xl:gap-16">
      <div>
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={toggleMic}
          disabled={busy}
          aria-label={recording ? "Stop" : "Speak your rules"}
          className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-full text-2xl text-paper transition disabled:opacity-40 ${recording ? "animate-pulse bg-danger" : "bg-ink hover:bg-ink/85"}`}
        >
          {recording ? "■" : "🎙"}
        </button>
        <p className="text-sm text-muted" lang="hi">
          {recording ? "बोलिए… फिर ■ दबाएँ" : busy ? "समझ रही हूँ…" : "जैसे: “सामान 350, पैकिंग 50, अमेरिका भेजने का 1200 लगता है, हर पीस पर कम से कम 1500 बचने चाहिए”"}
        </p>
      </div>
      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (typedRules.trim()) {
            void draftFrom({ text: typedRules.trim() });
            setTypedRules("");
          }
        }}
      >
        <input
          value={typedRules}
          onChange={(e) => setTypedRules(e.target.value.slice(0, 1500))}
          disabled={busy || recording}
          placeholder="या लिखें: सामान 350, पैकिंग 50, भेजने का 1200… · or type"
          lang="hi"
          className="min-w-0 flex-1 border border-line bg-card px-4 py-3 text-sm focus:border-ink focus:outline-none"
        />
        <button type="submit" disabled={busy || recording || !typedRules.trim()} className="shrink-0 border border-ink px-4 text-sm disabled:opacity-30">
          भेजें
        </button>
      </form>
      {heard && <p className="mt-4 bg-paper-deep/60 px-4 py-3 text-sm" lang="hi">“{heard}”</p>}

      {readback && (
        <section className="mt-6 border border-line bg-card p-5 sm:p-6">
          <div className="flex items-baseline justify-between gap-3">
            <p className="eyebrow deva">{dirty ? "मैंने यह समझा · Please check" : "अभी के नियम · Current rules"}</p>
            <button type="button" onClick={() => speak(readback, "hindi")} className="text-sm underline underline-offset-4">
              🔊 सुनें
            </button>
          </div>
          <p className="mt-2 leading-relaxed" lang="hi">
            {readback}
          </p>
        </section>
      )}

      <section className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {FIELDS.map((f) => {
          const v = rules[f.key] as number | null | boolean;
          const shown = typeof v === "number" ? (f.cents ? (v / 100).toString() : String(v)) : "";
          return (
            <label key={f.key} className="block">
              <span className="text-sm" lang="hi">
                {f.hi}
              </span>
              <span className="block text-xs text-muted">{f.en}</span>
              <span className="mt-1 flex items-center gap-2 border-b border-line focus-within:border-ink">
                <span className="text-muted">{f.unit === "#" ? "" : f.unit === "%" ? "" : f.unit}</span>
                <input
                  inputMode="decimal"
                  value={shown}
                  placeholder="—"
                  onChange={(e) => setField(f, e.target.value)}
                  className="w-full bg-transparent py-2 focus:outline-none"
                />
                {f.unit === "%" && <span className="text-muted">%</span>}
              </span>
            </label>
          );
        })}
        <label className="flex items-start gap-3 text-sm sm:col-span-2 [&>input]:mt-1">
          <input
            type="checkbox"
            checked={rules.askBeforeChanges}
            onChange={(e) => {
              setRules((r) => ({ ...r, askBeforeChanges: e.target.checked }));
              setDirty(true);
            }}
          />
          <span>
            <span lang="hi">रंग या सामान बदलने से पहले मुझसे पूछें</span>
            <span className="block text-xs text-muted">Ask me before changing colour or material</span>
          </span>
        </label>
      </section>

      </div>

      <aside className="max-lg:contents lg:sticky lg:top-8">
      <section className="mt-10 border border-line bg-card p-5 text-sm sm:p-6 lg:mt-0">
        <p className="eyebrow"><span className="deva">उदाहरण</span> · Example</p>
        <label className="mt-3 flex items-center gap-2">
          <span lang="hi">अगर दाम हो</span> $
          <input value={examplePrice} onChange={(e) => setExamplePrice(e.target.value.replace(/[^0-9.]/g, ""))} className="w-20 border-b border-line bg-transparent py-1 focus:border-ink focus:outline-none" />
        </label>
        {"verdict" in example ? (
          <div className="mt-3 space-y-1">
            <p lang="hi" className={example.verdict === "loss" ? "text-danger" : example.verdict === "below_minimum" ? "text-marigold" : ""}>
              {earningsSentenceHi(example, rules.minimumInr)}
            </p>
            <p className="text-xs text-muted">{earningsSentenceEn(example, rules.minimumInr)}</p>
            <p className="pt-2 text-xs text-muted">
              Buyer pays ${(example.buyerPaysUsdCents / 100).toFixed(2)} (incl. ${(example.shippingChargedUsdCents / 100).toFixed(2)} shipping) · est. PayPal fee $
              {(example.estFeeUsdCents / 100).toFixed(2)} · ≈ ₹{example.estInrAfterPayPal.toLocaleString("en-IN")} · your costs ₹{example.costs.total.toLocaleString("en-IN")}
            </p>
            <p className="text-[11px] text-muted">{example.assumptions.join(" · ")}</p>
          </div>
        ) : (
          <p className="mt-3 text-muted" lang="hi">
            अभी बताना बाकी है: {example.missing.join(", ")} · Missing: {example.missing.join(", ")}
          </p>
        )}
      </section>

      <div className="sticky bottom-0 z-10 -mx-4 mt-8 flex gap-3 border-t border-line bg-paper/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:static lg:mx-0 lg:mt-6 lg:border-t-0 lg:bg-transparent lg:px-0 lg:py-0 lg:backdrop-blur-none">
        <button type="button" onClick={approve} disabled={busy || !dirty} className="flex-1 bg-ink px-5 py-4 text-paper hover:bg-ink/85 disabled:opacity-30">
          सही है, सेव करें · Approve &amp; save
        </button>
      </div>
      {note && <p className="mt-3 text-sm text-danger">{note}</p>}
      </aside>
      </div>
    </div>
  );
}
