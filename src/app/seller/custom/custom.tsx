"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { SellerNav } from "@/components/seller-nav";
import { speak, startRecording, type Recorder } from "@/lib/client/media";

type Item = { id: string; status: string; summaryHi: string | null; buyerName: string | null; channel: string; createdAt: string };
type Check = { code: string; ok: boolean; blocking: boolean; hi: string; en: string };
type Draft = {
  index: number;
  status: "valid" | "blocked";
  option: { quantity: number; unitPriceUsdCents: number; note: string | null };
  completion: string;
  delivery: string;
  totalUsdCents: number;
  checks: Check[];
};
type View = {
  id: string;
  status: string;
  summaryHi: string | null;
  buyerName: string | null;
  channel: string;
  otherWishes: string | null;
  request: { text: string };
  advice: { hi: string[]; en: string[] };
  sellerSaid: string | null;
  draft: Draft[];
  options: { index: number; quantity: number; unitPriceUsdCents: number; readyBy: string }[];
  counter: { quantity: number; totalBudgetUsdCents: number; acceptable: boolean; reason: string | null } | null;
  agreement: { id: string; version: number; status: string; termsHash: string; lines: [string, string][]; buyerApproved: boolean; sellerApproved: boolean; payable: boolean } | null;
  agreementHi: string | null;
};

const STATUS_HI: Record<string, string> = { new: "नई", options_sent: "विकल्प भेजे", agreement: "समझौता", paid: "पैसे मिले", declined: "मना किया" };
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const hiDay = (iso: string) => new Date(iso).toLocaleDateString("hi-IN", { day: "numeric", month: "long", timeZone: "UTC" });

export function CustomRequests() {
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get("r");
  const [items, setItems] = useState<Item[] | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [heard, setHeard] = useState<string | null>(null);
  const [readback, setReadback] = useState<string | null>(null);
  const [send, setSend] = useState<Set<number>>(new Set());
  const [typed, setTyped] = useState("");
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const recorder = useRef<Recorder | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const res = await fetch("/api/seller/custom").catch(() => null);
      if (!cancelled && res?.ok) setItems((await res.json()).requests);
    };
    void tick();
    const t = setInterval(tick, 20_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    const tick = async () => {
      const res = await fetch(`/api/seller/custom/${selected}`).catch(() => null);
      if (!cancelled && res?.ok) setView(await res.json());
    };
    void tick();
    const t = setInterval(tick, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [selected]);

  function open(id: string) {
    setView(null);
    setHeard(null);
    setReadback(null);
    setSend(new Set());
    setNote(null);
    router.replace(`/seller/custom?r=${id}`);
  }

  async function post(body: FormData | Record<string, unknown>) {
    if (!selected) return null;
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/seller/custom/${selected}`, {
        method: "POST",
        ...(body instanceof FormData ? { body } : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      });
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

  async function answer(input: { audio?: Blob; text?: string }) {
    const form = new FormData();
    if (input.audio) form.append("audio", input.audio, "answer.wav");
    if (input.text) form.append("text", input.text);
    const out = await post(form);
    if (!out) return;
    setHeard(out.heard);
    setReadback(out.readback);
    setView(out.view);
    setSend(new Set((out.verdicts as Draft[]).map((v, i) => (v.status === "valid" ? i : -1)).filter((i) => i >= 0)));
    speak(out.readback, "hindi");
  }

  async function toggleMic() {
    if (recording) {
      const r = recorder.current;
      recorder.current = null;
      setRecording(false);
      if (r) await answer({ audio: await r.stop() });
      return;
    }
    try {
      recorder.current = await startRecording();
      setRecording(true);
    } catch {
      setNote("माइक्रोफ़ोन की अनुमति दें · Allow microphone access");
    }
  }

  async function action(body: Record<string, unknown>, said?: string) {
    const out = await post(body);
    if (out) {
      setView(out);
      if (said) speak(said, "hindi");
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-6 pb-24 pt-10">
      <SellerNav active="custom" />
      <header className="mb-8">
        <h1 className="font-display text-4xl font-normal">
          फ़रमाइश <span className="font-sans text-base font-light text-muted">Custom requests</span>
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted" lang="hi">
          ख़रीदार जो बनवाना चाहते हैं। आप बोलकर जवाब दें — हाट हर दाम और तारीख़ आपके नियमों से जाँचेगा।
          <span className="block text-xs">Answer by voice; every price and date is checked against your rules before the buyer sees it.</span>
        </p>
      </header>

      {items === null ? (
        <p className="text-muted">…</p>
      ) : items.length === 0 ? (
        <p className="bg-card p-6 text-muted" lang="hi">
          अभी कोई फ़रमाइश नहीं। · No custom requests yet.
        </p>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {items.map((it) => (
            <li key={it.id}>
              <button type="button" onClick={() => open(it.id)} className={`flex w-full items-start justify-between gap-4 py-4 text-left ${selected === it.id ? "text-ink" : "text-ink/80 hover:text-ink"}`}>
                <span lang="hi" className={selected === it.id ? "font-medium" : ""}>
                  {it.summaryHi}
                </span>
                <span className="eyebrow shrink-0">
                  {STATUS_HI[it.status] ?? it.status}
                  {it.channel === "mcp" && " · AI"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected && view && (
        <article className="mt-10">
          <section className="border-l-2 border-ink bg-card p-5">
            <div className="flex items-baseline justify-between gap-3">
              <p className="eyebrow">{view.buyerName ?? "ख़रीदार"}{view.channel === "mcp" ? " · via AI agent" : ""}</p>
              {view.summaryHi && (
                <button type="button" onClick={() => speak(view.summaryHi!, "hindi")} className="text-sm underline underline-offset-4">
                  🔊 सुनें
                </button>
              )}
            </div>
            <p className="mt-2 text-lg leading-relaxed" lang="hi">
              {view.summaryHi}
            </p>
            <p className="mt-3 text-xs italic text-muted">“{view.request.text}”</p>
            {view.otherWishes && <p className="mt-1 text-xs text-muted">Also: {view.otherWishes}</p>}
          </section>

          <section className="mt-6 text-sm">
            <p className="eyebrow">आपके नियमों से · From your rules</p>
            <ul className="mt-2 space-y-1">
              {view.advice.hi.map((line, i) => (
                <li key={line} lang="hi">
                  {line} <span className="block text-xs text-muted">{view.advice.en[i]}</span>
                </li>
              ))}
            </ul>
            {view.advice.hi.length > 0 && (
              <button type="button" onClick={() => speak(view.advice.hi.join(" "), "hindi")} className="mt-2 text-xs underline underline-offset-4">
                🔊 सुनें
              </button>
            )}
          </section>

          {view.status !== "paid" && view.status !== "declined" && (
            <section className="mt-10">
              <p className="eyebrow">आपका जवाब · Your answer</p>
              <div className="mt-3 flex items-center gap-4">
                <button
                  type="button"
                  onClick={toggleMic}
                  disabled={busy}
                  aria-label={recording ? "Stop" : "Speak your answer"}
                  className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-full text-2xl text-paper transition disabled:opacity-40 ${recording ? "animate-pulse bg-danger" : "bg-ink hover:bg-ink/85"}`}
                >
                  {recording ? "■" : "🎙"}
                </button>
                <p className="text-sm text-muted" lang="hi">
                  {recording ? "बोलिए… फिर ■ दबाएँ" : busy ? "समझ रही हूँ…" : "जैसे: “सात पीस 29 तारीख़ तक, पैंतीस डॉलर हर पीस। या बारहों 8 दिसंबर तक।”"}
                </p>
              </div>
              <form
                className="mt-3 flex gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (typed.trim()) void answer({ text: typed.trim() });
                }}
              >
                <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="या लिखें · or type" className="flex-1 border-b border-line bg-transparent py-2 text-sm focus:border-ink focus:outline-none" lang="hi" />
                <button type="submit" disabled={busy || !typed.trim()} className="text-sm underline underline-offset-4 disabled:opacity-30">
                  भेजें
                </button>
              </form>
              {(heard ?? view.sellerSaid) && (
                <p className="mt-4 bg-paper-deep/60 px-4 py-3 text-sm" lang="hi">
                  “{heard ?? view.sellerSaid}”
                </p>
              )}
              {readback && (
                <div className="mt-3 flex items-start justify-between gap-3 text-sm" lang="hi">
                  <p>{readback}</p>
                  <button type="button" onClick={() => speak(readback, "hindi")} className="shrink-0 underline underline-offset-4">
                    🔊
                  </button>
                </div>
              )}

              {view.draft.length > 0 && (
                <ul className="mt-6 space-y-3">
                  {view.draft.map((v) => (
                    <li key={v.index} className={`border p-4 ${v.status === "valid" ? "border-line bg-card" : "border-danger/40 bg-danger/5"}`}>
                      <label className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          disabled={v.status !== "valid"}
                          checked={send.has(v.index)}
                          onChange={(e) =>
                            setSend((s) => {
                              const n = new Set(s);
                              if (e.target.checked) n.add(v.index);
                              else n.delete(v.index);
                              return n;
                            })
                          }
                          className="mt-1.5"
                        />
                        <span className="flex-1">
                          <span className="block font-medium">
                            {v.option.quantity} पीस · {usd(v.option.unitPriceUsdCents)} हर पीस · कुल {usd(v.totalUsdCents)}
                          </span>
                          <span className="block text-xs text-muted" lang="hi">
                            {hiDay(v.completion)} तक तैयार · पहुँचने का अनुमान {hiDay(v.delivery)}
                          </span>
                          {v.checks.map((c) => (
                            <span key={c.code} className={`mt-1 block text-sm ${c.blocking ? "text-danger" : c.ok ? "" : "text-marigold"}`} lang="hi">
                              {c.blocking ? "✗ " : c.ok ? "✓ " : "! "}
                              {c.hi} <span className="text-xs text-muted">{c.en}</span>
                            </span>
                          ))}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              {view.draft.some((v) => v.status === "valid") && (
                <button
                  type="button"
                  disabled={busy || send.size === 0}
                  onClick={() => action({ action: "send", indexes: [...send] }, "विकल्प ख़रीदार को भेज दिए।")}
                  className="mt-4 w-full bg-ink px-5 py-4 text-paper hover:bg-ink/85 disabled:opacity-30"
                >
                  ख़रीदार को भेजें · Send {send.size} option{send.size === 1 ? "" : "s"}
                </button>
              )}
            </section>
          )}

          {view.options.length > 0 && (
            <section className="mt-8 text-sm">
              <p className="eyebrow">भेजे गए · Sent to buyer</p>
              <ul className="mt-2 space-y-1" lang="hi">
                {view.options.map((o) => (
                  <li key={o.index}>
                    {o.quantity} पीस · {usd(o.unitPriceUsdCents)} हर पीस · {hiDay(o.readyBy)} तक
                  </li>
                ))}
              </ul>
            </section>
          )}

          {view.counter && (
            <section className="mt-6 text-sm">
              <p className="eyebrow">ख़रीदार का सुझाव · Buyer&apos;s counter</p>
              <p className="mt-2">
                {view.counter.quantity} pcs for {usd(view.counter.totalBudgetUsdCents)} —{" "}
                {view.counter.acceptable ? <span className="text-leaf">within your rules</span> : <span className="text-marigold">refused automatically: {view.counter.reason}</span>}
              </p>
            </section>
          )}

          {view.agreement && view.agreement.status !== "cancelled" && (
            <section className="mt-10 border-t-2 border-ink pt-6">
              <div className="flex items-baseline justify-between gap-3">
                <p className="eyebrow">समझौता · Terms v{view.agreement.version}</p>
                {view.agreementHi && (
                  <button type="button" onClick={() => speak(view.agreementHi!, "hindi")} className="text-sm underline underline-offset-4">
                    🔊 सुनें
                  </button>
                )}
              </div>
              {view.agreementHi && (
                <p className="mt-3 leading-relaxed" lang="hi">
                  {view.agreementHi}
                </p>
              )}
              <dl className="mt-4 divide-y divide-line text-xs text-muted">
                {view.agreement.lines.map(([k, v]) => (
                  <div key={k} className="grid grid-cols-[8rem_1fr] gap-3 py-2">
                    <dt>{k}</dt>
                    <dd className="text-ink">{v}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-4 flex gap-6 text-sm">
                <span className={view.agreement.buyerApproved ? "text-leaf" : "text-muted"}>{view.agreement.buyerApproved ? "✓" : "○"} ख़रीदार</span>
                <span className={view.agreement.sellerApproved ? "text-leaf" : "text-muted"}>{view.agreement.sellerApproved ? "✓" : "○"} आप</span>
              </div>
              {view.agreement.status === "paid" ? (
                <p className="mt-4 text-leaf" lang="hi">
                  पैसे मिल गए — काम शुरू कर सकती हैं। · Paid.
                </p>
              ) : (
                !view.agreement.sellerApproved && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => action({ action: "approve", agreementId: view.agreement!.id, hash: view.agreement!.termsHash }, "आपने समझौता मंज़ूर किया।")}
                    className="mt-5 w-full bg-ink px-5 py-4 text-paper hover:bg-ink/85 disabled:opacity-30"
                  >
                    यही शर्तें मंज़ूर हैं · Approve these exact terms
                  </button>
                )
              )}
              {view.agreement.payable && (
                <p className="mt-3 text-sm text-muted" lang="hi">
                  दोनों ने मंज़ूर किया — ख़रीदार के भुगतान का इंतज़ार। आपका समय 48 घंटे के लिए रोका गया है।
                </p>
              )}
            </section>
          )}

          {view.status !== "paid" && view.status !== "declined" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (confirm("इस फ़रमाइश को मना करें? · Decline this request?")) void action({ action: "decline" }, "ख़रीदार को बता दिया कि आप यह नहीं बना पाएँगी।");
              }}
              className="mt-10 text-sm text-muted underline underline-offset-4 hover:text-danger"
            >
              मना करें · Decline
            </button>
          )}
          {note && <p className="mt-3 text-sm text-danger">{note}</p>}
        </article>
      )}
    </div>
  );
}
