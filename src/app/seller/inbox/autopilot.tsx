"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { speak, startRecording, type Recorder } from "@/lib/client/media";

type ActionView = {
  id: string;
  tool: string;
  status: string;
  summaryHi: string | null;
  summaryEn: string | null;
  amountCents: number | null;
  amountInr: number | null;
  policyReasons: string[];
  result: Record<string, unknown> | null;
  buyerSaid: string | null;
  order: { id: string; amountCents: number; buyerName: string | null; refundedCents: number } | null;
  at: string;
};
type ToShip = { id: string; amountCents: number; buyerName: string | null; shipTo: string | null; capturedAt: string | null; custom?: boolean };
type Making = { requestId: string; summaryHi: string | null; done: number; total: number; readyBy: string };
type Board = {
  proposals: ActionView[];
  activity: ActionView[];
  toShip: ToShip[];
  custom: { newRequests: number; awaitingYourApproval: number; inProduction: Making[] };
};

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

async function postForm(url: string, form?: FormData) {
  const res = await fetch(url, { method: "POST", body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? "Something went wrong");
  return body;
}

/** Hold-free recorder button: tap to start, tap to stop; returns the WAV. */
function MicButton({ onAudio, disabled, label }: { onAudio: (wav: Blob) => void; disabled?: boolean; label: string }) {
  const rec = useRef<Recorder | null>(null);
  const [on, setOn] = useState(false);
  useEffect(() => () => rec.current?.cancel(), []);
  async function toggle() {
    if (on) {
      const r = rec.current;
      rec.current = null;
      setOn(false);
      if (r) onAudio(await r.stop());
      return;
    }
    rec.current = await startRecording();
    setOn(true);
  }
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled}
      className={`inline-flex items-center gap-3 px-5 py-3 text-sm text-paper transition disabled:opacity-40 ${on ? "animate-pulse bg-danger" : "bg-ink hover:bg-ink/85"}`}
    >
      <span aria-hidden>{on ? "■" : "🎙"}</span>
      {on ? "रुकें · Stop" : label}
    </button>
  );
}

export function Autopilot({ refreshKey, onChange }: { refreshKey: number; onChange: () => void }) {
  const [board, setBoard] = useState<Board | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const res = await fetch("/api/seller/autopilot").catch(() => null);
      if (!cancelled && res?.ok) setBoard(await res.json());
    };
    void tick();
    const t = setInterval(tick, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [refreshKey]);

  if (!board) return null;
  const waiting = board.custom.newRequests + board.custom.awaitingYourApproval;
  return (
    <div className="space-y-14">
      {waiting > 0 && (
        <Link href="/seller/custom" className="block border-l-2 border-marigold bg-card p-5 hover:bg-paper-deep/60">
          <p lang="hi">
            {board.custom.newRequests > 0 && <span className="block">{board.custom.newRequests} नई फ़रमाइश — बोलकर जवाब दें</span>}
            {board.custom.awaitingYourApproval > 0 && <span className="block">{board.custom.awaitingYourApproval} समझौता आपकी मंज़ूरी का इंतज़ार कर रहा है</span>}
          </p>
          <span className="mt-1 block text-xs text-muted">
            {board.custom.newRequests} new custom request{board.custom.newRequests === 1 ? "" : "s"} · {board.custom.awaitingYourApproval} agreement{board.custom.awaitingYourApproval === 1 ? "" : "s"} to approve →
          </span>
        </Link>
      )}

      {board.custom.inProduction.length > 0 && (
        <section>
          <h2 className="eyebrow text-ink"><span className="deva">बन रहे हैं</span> · Being made</h2>
          <ol className="mt-5 space-y-4">
            {board.custom.inProduction.map((m) => (
              <MakingCard key={m.requestId} m={m} onDone={onChange} />
            ))}
          </ol>
        </section>
      )}
      {board.proposals.length > 0 && (
        <section>
          <h2 className="eyebrow text-ink"><span className="deva">आपकी मंज़ूरी चाहिए</span> · Needs your approval</h2>
          <ol className="mt-5 space-y-6">
            {board.proposals.map((p) => (
              <ProposalCard key={p.id} p={p} onDone={onChange} />
            ))}
          </ol>
        </section>
      )}

      {board.toShip.length > 0 && (
        <section>
          <h2 className="eyebrow text-ink"><span className="deva">भेजने के लिए तैयार</span> · Ready to ship</h2>
          <p className="mt-2 text-sm text-muted">
            ट्रैकिंग नंबर जोड़ने से PayPal Seller Protection मज़बूत होता है और पैसा जल्दी मिल सकता है।
            <span className="block text-xs">Adding tracking strengthens Seller Protection and can release held funds sooner.</span>
          </p>
          <ol className="mt-5 space-y-6">
            {board.toShip.map((o) => (
              <TrackingCard key={o.id} o={o} onDone={onChange} />
            ))}
          </ol>
        </section>
      )}

      {board.activity.length > 0 && (
        <section>
          <h2 className="eyebrow text-ink">
            AI <span className="deva">ने क्या किया</span> · Autopilot activity
          </h2>
          <ol className="mt-4 divide-y divide-line border-y border-line">
            {board.activity.slice(0, 8).map((a) => (
              <ActivityRow key={a.id} a={a} />
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function ProposalCard({ p, onDone }: { p: ActionView; onDone: () => void }) {
  const [challenge, setChallenge] = useState<{ word: string; wordEn: string; promptHi: string } | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function startApproval() {
    setBusy(true);
    setNote(null);
    try {
      const c = await postForm(`/api/seller/actions/${p.id}/challenge`);
      setChallenge(c);
      speak(c.promptHi, "hindi");
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submit(audio?: Blob) {
    setBusy(true);
    setNote(null);
    const form = new FormData();
    if (audio) form.append("audio", audio, "word.wav");
    else form.append("word", typed);
    try {
      const r = await postForm(`/api/seller/actions/${p.id}/approve`, form);
      if (r.approved) {
        speak(r.action?.status === "executed" ? "पैसा वापस भेज दिया गया है।" : "मंज़ूर हुआ, पर PayPal पर नहीं जा सका।", "hindi");
        onDone();
      } else {
        setNote(`सुना: “${r.heard || "—"}”. शब्द मेल नहीं खाया · Didn't match (${r.attemptsLeft} tries left)`);
      }
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    try {
      await postForm(`/api/seller/actions/${p.id}/reject`);
      onDone();
    } catch (e) {
      setNote((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <li className="border border-ink/80 bg-card p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="font-display text-3xl">
          {p.amountCents !== null && usd(p.amountCents)}{" "}
          {p.amountInr !== null && <span className="font-sans text-base text-muted">≈ {inr(p.amountInr)}</span>}
        </p>
        <p className="eyebrow"><span className="deva">रिफ़ंड का सुझाव</span> · Refund proposal</p>
      </div>
      {p.buyerSaid && (
        <p className="mt-4 border-l-2 border-line pl-3 text-sm text-muted" lang="hi">
          ख़रीदार: {p.buyerSaid}
        </p>
      )}
      {p.summaryHi && (
        <p className="mt-4 leading-relaxed" lang="hi">
          {p.summaryHi}
        </p>
      )}
      {p.summaryEn && <p className="mt-1 text-xs text-muted">{p.summaryEn}</p>}
      {p.policyReasons.length > 0 && (
        <p className="mt-3 text-xs text-muted">Why it needs you: {p.policyReasons.join(" · ")}</p>
      )}

      {!challenge ? (
        <div className="mt-6 flex flex-wrap gap-3">
          <button type="button" onClick={startApproval} disabled={busy} className="bg-ink px-5 py-3 text-sm text-paper hover:bg-ink/85 disabled:opacity-40">
            हाँ, लौटाएँ · Approve
          </button>
          <button type="button" onClick={decline} disabled={busy} className="border border-ink px-5 py-3 text-sm hover:bg-ink hover:text-paper disabled:opacity-40">
            नहीं · Decline
          </button>
          <button type="button" onClick={() => p.summaryHi && speak(p.summaryHi, "hindi")} className="px-2 text-sm underline underline-offset-4">
            🔊 सुनें
          </button>
        </div>
      ) : (
        <div className="mt-6 border-t border-line pt-6 text-center">
          <p className="eyebrow"><span className="deva">पक्का करने के लिए यह शब्द बोलिए</span> · Say this word to confirm</p>
          <p className="mt-3 font-display text-6xl" lang="hi">
            {challenge.word}
          </p>
          <p className="mt-1 text-xs text-muted">({challenge.wordEn})</p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <MicButton onAudio={(wav) => submit(wav)} disabled={busy} label="बोलिए · Speak" />
          </div>
          <div className="mx-auto mt-4 flex max-w-xs gap-2">
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="या लिखिए · or type it"
              className="min-w-0 flex-1 border border-line bg-paper px-3 py-2 text-sm focus:border-ink focus:outline-none"
              lang="hi"
            />
            <button type="button" onClick={() => submit()} disabled={busy || !typed.trim()} className="border border-ink px-4 text-sm disabled:opacity-30">
              ✓
            </button>
          </div>
        </div>
      )}
      {busy && <p className="mt-3 text-center text-xs text-muted">…</p>}
      {note && <p className="mt-3 text-center text-sm text-danger">{note}</p>}
    </li>
  );
}

function TrackingCard({ o, onDone }: { o: ToShip; onDone: () => void }) {
  const [heard, setHeard] = useState<{ carrier: string; carrierLabel: string; trackingNumber: string; valid: boolean; readBackHi: string } | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function understand(audio?: Blob) {
    setBusy(true);
    setNote(null);
    const form = new FormData();
    if (audio) form.append("audio", audio, "tracking.wav");
    else form.append("text", typed);
    try {
      const h = await postForm(`/api/seller/orders/${o.id}/tracking/heard`, form);
      setHeard(h);
      speak(h.valid ? h.readBackHi : "यह नंबर सही नहीं लग रहा। कृपया फिर से बोलिए।", "hindi");
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!heard) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/seller/orders/${o.id}/tracking`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ carrier: heard.carrier, trackingNumber: heard.trackingNumber }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      speak("ट्रैकिंग PayPal में जोड़ दी गई है।", "hindi");
      onDone();
    } catch (e) {
      setNote((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <li className="border border-line bg-card p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-display text-2xl">{usd(o.amountCents)}</p>
        <p className="eyebrow"><span className="deva">पैसा मिल गया</span> · Paid</p>
      </div>
      <p className="mt-1 text-sm text-muted">
        {o.buyerName ?? "Buyer"}
        {o.shipTo && ` · ${o.shipTo}`}
      </p>

      {!heard ? (
        <div className="mt-5 space-y-3">
          <MicButton onAudio={(wav) => understand(wav)} disabled={busy} label="कूरियर और ट्रैकिंग नंबर बोलिए" />
          <div className="flex gap-2">
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="या लिखिए: India Post EE123456789IN"
              className="min-w-0 flex-1 border border-line bg-paper px-3 py-2 text-sm focus:border-ink focus:outline-none"
            />
            <button type="button" onClick={() => understand()} disabled={busy || typed.trim().length < 6} className="border border-ink px-4 text-sm disabled:opacity-30">
              →
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-5 border-t border-line pt-5">
          <p className="eyebrow deva">{heard.carrierLabel}</p>
          <p className="mt-2 font-mono text-2xl tracking-wider">{heard.trackingNumber}</p>
          {!heard.valid && <p className="mt-2 text-sm text-danger">यह नंबर सही नहीं लग रहा · This doesn’t look like a valid number</p>}
          <div className="mt-5 flex flex-wrap gap-3">
            <button type="button" onClick={confirm} disabled={busy || !heard.valid} className="bg-ink px-5 py-3 text-sm text-paper hover:bg-ink/85 disabled:opacity-40">
              सही है · Add to PayPal
            </button>
            <button type="button" onClick={() => setHeard(null)} disabled={busy} className="border border-ink px-5 py-3 text-sm">
              फिर से · Redo
            </button>
            <button type="button" onClick={() => speak(heard.readBackHi, "hindi")} className="px-2 text-sm underline underline-offset-4">
              🔊 सुनें
            </button>
          </div>
        </div>
      )}
      {note && <p className="mt-3 text-sm text-danger">{note}</p>}
    </li>
  );
}

function ActivityRow({ a }: { a: ActionView }) {
  const label =
    a.tool === "recommend_no_refund"
      ? { hi: "अभी रिफ़ंड नहीं — सुझाव", en: "Suggested no refund yet", tone: "text-muted" }
      : a.status === "executed"
        ? { hi: `${a.amountCents !== null ? usd(a.amountCents) : ""} वापस भेजा गया`, en: "Refunded on PayPal · approved by voice", tone: "text-leaf" }
        : a.status === "blocked"
          ? { hi: "नियमों ने रोका", en: "Blocked by store rules", tone: "text-danger" }
          : a.status === "rejected"
            ? { hi: "आपने मना किया", en: "You declined", tone: "text-muted" }
            : a.status === "failed"
              ? { hi: "PayPal पर नहीं हो सका", en: "PayPal error", tone: "text-danger" }
              : { hi: a.status, en: a.status, tone: "text-muted" };
  const reasons = (a.result as { reasons?: string[] } | null)?.reasons;
  return (
    <li className="py-4 text-sm">
      <div className="flex justify-between gap-4">
        <p className={label.tone}>
          {label.hi} <span className="text-xs text-muted">· {label.en}</span>
        </p>
        <p className="eyebrow shrink-0">{new Date(a.at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</p>
      </div>
      {a.summaryHi && (
        <p className="mt-1 text-muted" lang="hi">
          {a.summaryHi}
        </p>
      )}
      {reasons && <p className="mt-1 text-xs text-muted">{reasons.join(" · ")}</p>}
    </li>
  );
}

const hiDay = (iso: string) => new Date(iso).toLocaleDateString("hi-IN", { day: "numeric", month: "long", timeZone: "UTC" });

/** Paid custom order in production: she taps as pieces are finished. */
export function MakingCard({ m, onDone }: { m: Making; onDone: () => void }) {
  const [done, setDone] = useState(m.done);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function save(next: number) {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/seller/custom/${m.requestId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "progress", piecesDone: next }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setDone(next);
      speak(next === m.total ? "सारे पीस बन गए। अब भेजने के लिए तैयार है।" : `${m.total} में से ${next} पीस बन गए।`, "hindi");
      onDone();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="bg-card p-5">
      <p lang="hi">{m.summaryHi}</p>
      <div className="mt-3 h-1.5 bg-line" aria-hidden>
        <div className="h-1.5 bg-ink transition-all" style={{ width: `${Math.round((done / m.total) * 100)}%` }} />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm">
        <span lang="hi">
          {m.total} में से {done} पीस बने · {hiDay(m.readyBy)} तक
        </span>
        <span className="flex gap-2">
          <button type="button" disabled={busy || done <= 0} onClick={() => save(done - 1)} className="border border-line px-3 py-1 disabled:opacity-30" aria-label="One fewer">
            −
          </button>
          <button type="button" disabled={busy || done >= m.total} onClick={() => save(done + 1)} className="bg-ink px-4 py-1 text-paper disabled:opacity-30">
            +1 पीस बना
          </button>
          {done < m.total && (
            <button type="button" disabled={busy} onClick={() => save(m.total)} className="underline underline-offset-4 disabled:opacity-30">
              सब बन गए
            </button>
          )}
        </span>
      </div>
      {note && <p className="mt-2 text-sm text-danger">{note}</p>}
    </li>
  );
}
