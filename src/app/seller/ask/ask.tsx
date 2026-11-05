"use client";

import { useEffect, useRef, useState } from "react";
import { SellerNav, StudioHeader } from "@/components/seller-nav";
import { speak, startRecording, type Recorder } from "@/lib/client/media";
import type { Card } from "@/lib/ask/agent";

type Turn = { role: "seller" | "haat"; text: string; cards?: Card[] };

const EXAMPLES = ["आज कितना कमाया?", "इस हफ़्ते PayPal में कितने पैसे आए?", "किन ग्राहकों को जवाब देना है?", "सारा के लिए लाल दुपट्टे का 1200 रुपये का बिल बनाओ"];

export function Ask() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<Recorder | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollIntoView, and an effect may only return a cleanup function.
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, busy]);
  useEffect(() => () => recorder.current?.cancel(), []);

  async function ask(input: { audio?: Blob; text?: string }) {
    setBusy(true);
    setError(null);
    const form = new FormData();
    if (input.audio) form.append("audio", input.audio, "question.wav");
    if (input.text) form.append("text", input.text);
    form.append("history", JSON.stringify(turns.map(({ role, text }) => ({ role, text }))));
    try {
      const res = await fetch("/api/seller/ask", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Something went wrong");
      setTurns((t) => [...t, { role: "seller", text: body.heard }, { role: "haat", text: body.replyHi, cards: body.cards }]);
      speak(body.replyHi, "hindi");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleMic() {
    if (recording) {
      const r = recorder.current;
      recorder.current = null;
      setRecording(false);
      if (r) await ask({ audio: await r.stop() });
      return;
    }
    try {
      recorder.current = await startRecording();
      setRecording(true);
    } catch {
      setError("माइक्रोफ़ोन की अनुमति दें · Please allow microphone access");
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 pb-10 pt-8 sm:px-6 lg:px-10 xl:px-12">
      <SellerNav active="ask" />
      <StudioHeader hi="पूछो हाट" en="Ask Haat">
        <p>
          अपनी दुकान के बारे में कुछ भी पूछिए, या बिल बनवाइए। पैसे से जुड़ा हर काम आपकी मंज़ूरी से ही होगा।
          <span className="block text-xs">Ask anything about your shop, or have Haat draft an invoice. Nothing is sent without your tap.</span>
        </p>
      </StudioHeader>

      <div className="flex flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start lg:gap-12 xl:grid-cols-[minmax(0,1fr)_21rem] xl:gap-16">
      <div className="flex min-h-[55vh] flex-col">
      <div className="w-full flex-1 space-y-6">
        {turns.length === 0 && (
          <div className="hidden h-full min-h-64 flex-col items-center justify-center border border-dashed border-line text-center lg:flex">
            <p className="font-display text-2xl" lang="hi">
              बोलकर पूछिए
            </p>
            <p className="mt-1 text-sm text-muted">Tap the mic below and ask in Hindi — or type, or pick a question on the right.</p>
          </div>
        )}
        {turns.length === 0 && (
          <div className="flex flex-wrap gap-2 lg:hidden">
            {EXAMPLES.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => ask({ text: q })}
                disabled={busy}
                className="border border-line bg-card px-3 py-2 text-sm transition hover:border-ink disabled:opacity-40"
                lang="hi"
              >
                {q}
              </button>
            ))}
          </div>
        )}

        {turns.map((t, i) =>
          t.role === "seller" ? (
            <p key={i} className="ml-auto max-w-[85%] bg-paper-deep/70 px-4 py-3 text-right" lang="hi">
              {t.text}
            </p>
          ) : (
            <div key={i} className="max-w-[92%] space-y-3">
              <div className="border-l-2 border-ink bg-card px-4 py-3">
                <p className="eyebrow deva mb-1">हाट</p>
                <p className="leading-relaxed" lang="hi">
                  {t.text}
                </p>
                <button type="button" onClick={() => speak(t.text, "hindi")} className="mt-2 text-xs underline underline-offset-4">
                  🔊 फिर सुनें
                </button>
              </div>
              {t.cards?.map((c, j) => <CardView key={j} card={c} />)}
            </div>
          ),
        )}
        {busy && <p className="text-sm text-muted">सुन रही हूँ… · Thinking…</p>}
        {error && <p className="text-sm text-danger">{error}</p>}
        <div ref={end} />
      </div>

      <div className="sticky bottom-0 mt-8 w-full border-t border-line bg-paper pb-3 pt-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={toggleMic}
            disabled={busy}
            aria-label={recording ? "Stop and ask" : "Ask by voice"}
            className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-full text-2xl text-paper transition disabled:opacity-40 ${recording ? "animate-pulse bg-danger" : "bg-ink hover:bg-ink/85"}`}
          >
            {recording ? "■" : "🎙"}
          </button>
          <form
            className="flex min-w-0 flex-1 gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (typed.trim()) {
                void ask({ text: typed.trim() });
                setTyped("");
              }
            }}
          >
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={recording ? "बोलिए… फिर ■ दबाएँ" : "या लिखिए…"}
              disabled={busy || recording}
              className="min-w-0 flex-1 border border-line bg-card px-4 py-3 text-sm focus:border-ink focus:outline-none"
              lang="hi"
            />
            <button type="submit" disabled={busy || !typed.trim()} className="border border-ink px-4 text-sm disabled:opacity-30">
              →
            </button>
          </form>
        </div>
      </div>
      </div>

      <aside className="hidden space-y-6 lg:sticky lg:top-8 lg:block">
        <section className="border border-line bg-card p-5">
          <p className="eyebrow"><span className="deva">पूछकर देखिए</span> · Try asking</p>
          <div className="mt-4 flex flex-col gap-2">
            {EXAMPLES.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => ask({ text: q })}
                disabled={busy}
                className="border border-line bg-paper/60 px-3 py-2 text-left text-sm transition hover:border-ink disabled:opacity-40"
                lang="hi"
              >
                {q}
              </button>
            ))}
          </div>
        </section>
        <section className="border border-line bg-card p-5 text-sm">
          <p className="eyebrow"><span className="deva">हाट क्या कर सकता है</span> · What Haat can do</p>
          <ul className="mt-3 space-y-2">
            <li lang="hi">कमाई और PayPal के पैसे बताना<span className="block text-xs text-muted">Earnings and PayPal payments</span></li>
            <li lang="hi">फ़रमाइश और बाकी काम बताना<span className="block text-xs text-muted">Custom requests and pending work</span></li>
            <li lang="hi">बिल और जवाब तैयार करना<span className="block text-xs text-muted">Draft invoices and replies — you confirm</span></li>
          </ul>
        </section>
      </aside>
      </div>
    </div>
  );
}

function CardView({ card }: { card: Card }) {
  if (card.type === "orders") {
    return (
      <ul className="divide-y divide-line border-y border-line text-sm">
        {card.orders.map((o) => (
          <li key={o.id} className="flex justify-between gap-3 py-2">
            <span>
              {o.amount} · {o.buyer ?? "Buyer"}
            </span>
            <span className="text-xs text-muted">
              {o.status}
              {o.tracking ? ` · ${o.tracking}` : ""}
            </span>
          </li>
        ))}
      </ul>
    );
  }
  return card.type === "invoice_draft" ? <InvoiceCard card={card} /> : <ReplyCard card={card} />;
}

async function post(url: string, payload?: Record<string, unknown>) {
  const res = await fetch(url, { method: "POST", ...(payload ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) } : {}) });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "Failed");
  return body;
}

function InvoiceCard({ card }: { card: Extract<Card, { type: "invoice_draft" }> }) {
  const [state, setState] = useState<"draft" | "busy" | "done" | "cancelled">("draft");
  const [result, setResult] = useState<{ link: string | null; qr: string | null; emailed: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [anyway, setAnyway] = useState(false);
  const warn = card.check.needsOverride;

  async function confirm() {
    setState("busy");
    setError(null);
    try {
      const r = await post(`/api/seller/ask/actions/${card.actionId}/confirm`, warn ? { override: anyway } : undefined);
      setResult(r);
      setState("done");
      speak("PayPal का बिल बन गया है। लिंक या QR कोड ग्राहक को भेज दीजिए।", "hindi");
    } catch (e) {
      setError((e as Error).message);
      setState("draft");
    }
  }

  const share = result?.link
    ? `https://wa.me/?text=${encodeURIComponent(`Hello ${card.buyerName}! Here is the PayPal payment link for your ${card.item} ($${(card.amountCents / 100).toFixed(2)}): ${result.link}`)}`
    : null;

  return (
    <div className="border border-ink/80 bg-card p-5">
      <p className="eyebrow">
        PayPal <span className="deva">बिल</span> · Invoice {state === "draft" ? "(draft)" : ""}</p>
      <p className="mt-2 font-display text-3xl">
        ${(card.amountCents / 100).toFixed(2)} <span className="font-sans text-sm text-muted">≈ ₹{card.amountInr.toLocaleString("en-IN")}</span>
      </p>
      <p className="mt-1 text-sm">
        {card.pieces > 1 ? `${card.pieces} × ` : ""}
        {card.item} · {card.buyerName}
        {card.buyerEmail && <span className="text-muted"> · {card.buyerEmail}</span>}
      </p>

      <p lang="hi" className={`mt-3 text-sm ${card.check.verdict === "loss" ? "text-danger" : warn ? "text-marigold" : "text-muted"}`}>
        {warn ? "⚠ " : ""}
        {card.check.hi}
        <span className="block text-xs text-muted">{card.check.en}</span>
      </p>

      {state === "draft" || state === "busy" ? (
        <div className="mt-4 space-y-3">
          {warn && (
            <label className="flex items-start gap-2 text-sm" lang="hi">
              <input type="checkbox" checked={anyway} onChange={(e) => setAnyway(e.target.checked)} className="mt-1" />
              <span>
                मुझे पता है यह मेरे नियम से कम है, फिर भी बिल बनाना है।
                <span className="block text-xs text-muted">I know this is below my own rules and want it anyway.</span>
              </span>
            </label>
          )}
          <div className="flex gap-3">
          <button type="button" onClick={confirm} disabled={state === "busy" || (warn && !anyway)} className="bg-ink px-5 py-3 text-sm text-paper hover:bg-ink/85 disabled:opacity-40">
            {state === "busy" ? "बना रहे हैं… · Creating…" : warn ? "फिर भी बिल बनाओ · Create anyway" : "बिल बनाओ · Create PayPal link"}
          </button>
          <button
            type="button"
            disabled={state === "busy"}
            onClick={async () => {
              await post(`/api/seller/ask/actions/${card.actionId}/cancel`).catch(() => null);
              setState("cancelled");
            }}
            className="border border-ink px-5 py-3 text-sm"
          >
            रद्द · Cancel
          </button>
          </div>
        </div>
      ) : state === "cancelled" ? (
        <p className="mt-3 text-sm text-muted">रद्द किया · Cancelled</p>
      ) : (
        result && (
          <div className="mt-4 flex flex-wrap items-center gap-5">
            {result.qr && <img src={result.qr} alt="PayPal invoice QR code" className="h-36 w-36 bg-white p-2" />}
            <div className="space-y-3 text-sm">
              <p className="text-leaf">✓ PayPal बिल तैयार · Invoice created{result.emailed ? " and emailed" : ""}</p>
              {share && (
                <a href={share} target="_blank" rel="noopener noreferrer" className="inline-block bg-ink px-4 py-2 text-paper">
                  WhatsApp पर भेजें
                </a>
              )}
              {result.link && (
                <a href={result.link} target="_blank" rel="noopener noreferrer" className="block break-all text-xs text-muted underline">
                  {result.link}
                </a>
              )}
            </div>
          </div>
        )
      )}
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
    </div>
  );
}

function ReplyCard({ card }: { card: Extract<Card, { type: "reply_draft" }> }) {
  const [state, setState] = useState<"draft" | "busy" | "done" | "cancelled">("draft");
  const [english, setEnglish] = useState<string | null>(null);
  return (
    <div className="border border-ink/80 bg-card p-5 text-sm">
      <p className="eyebrow"><span className="deva">जवाब</span> · Reply {state === "draft" ? "(draft)" : ""}</p>
      <p className="mt-2 text-muted" lang="hi">
        ख़रीदार: {card.buyerSaid}
      </p>
      <p className="mt-2 text-base" lang="hi">
        {card.replyHi}
      </p>
      {state === "done" ? (
        <p className="mt-3 text-leaf">✓ भेज दिया · Sent in English: {english}</p>
      ) : state === "cancelled" ? (
        <p className="mt-3 text-muted">रद्द किया · Cancelled</p>
      ) : (
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            disabled={state === "busy"}
            onClick={async () => {
              setState("busy");
              try {
                const r = await post(`/api/seller/ask/actions/${card.actionId}/confirm`);
                setEnglish(r.english);
                setState("done");
              } catch {
                setState("draft");
              }
            }}
            className="bg-ink px-5 py-3 text-paper hover:bg-ink/85 disabled:opacity-40"
          >
            {state === "busy" ? "…" : "भेजें · Send"}
          </button>
          <button
            type="button"
            onClick={async () => {
              await post(`/api/seller/ask/actions/${card.actionId}/cancel`).catch(() => null);
              setState("cancelled");
            }}
            className="border border-ink px-5 py-3"
          >
            रद्द
          </button>
        </div>
      )}
    </div>
  );
}
