"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { speak, startRecording, type Recorder } from "@/lib/client/media";
import { Autopilot } from "./autopilot";

type Flag = { code: string; hi: string; en: string };
type InboxMessage = {
  id: string;
  channel: string;
  originalText: string;
  originalLanguage: string | null;
  translatedText: string | null;
  createdAt: string;
  productTitle: string | null;
  orderStatus: string | null;
  orderId: string | null;
  shield: { level: "safe" | "caution" | "danger"; flags: Flag[]; checkedAgainstPayPal: boolean } | null;
  replies: { id: string; text: string; english: string | null; at: string }[];
};

const timeAgo = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? "अभी" : m < 60 ? `${m} मिनट पहले` : m < 1440 ? `${Math.round(m / 60)} घंटे पहले` : `${Math.round(m / 1440)} दिन पहले`;
};

export function Inbox() {
  const [messages, setMessages] = useState<InboxMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const res = await fetch("/api/seller/messages").catch(() => null);
      if (cancelled) return;
      if (res?.ok) setMessages((await res.json()).messages);
      else setError("संदेश लोड नहीं हुए · Couldn't load messages");
    };
    void tick();
    const t = setInterval(tick, 20_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [refresh]);

  const dangers = messages?.filter((m) => m.shield?.level === "danger").length ?? 0;

  return (
    <div className="mx-auto w-full max-w-2xl px-6 pb-24 pt-10">
      <header className="mb-10 border-b border-line pb-8">
        <div className="flex items-baseline justify-between">
          <p className="eyebrow">Seller studio · विक्रेता</p>
          <Link href="/seller/list" className="eyebrow text-ink underline underline-offset-4">
            + नया सामान
          </Link>
        </div>
        <h1 className="mt-3 font-display text-4xl font-normal">
          आज का काम <span className="font-sans text-base font-light text-muted">Today’s inbox</span>
        </h1>
        {dangers > 0 && (
          <p className="mt-4 border-l-2 border-danger bg-danger-soft px-4 py-3 text-sm text-danger">
            {dangers} संदेशों में धोखे के संकेत हैं। पहले उन्हें सुनें।
            <span className="block text-xs opacity-80">{dangers} messages show scam warning signs.</span>
          </p>
        )}
      </header>

      <Autopilot refreshKey={refresh} onChange={() => setRefresh((n) => n + 1)} />

      <h2 className="eyebrow mt-14 border-t border-line pt-10 text-ink">ख़रीदारों के संदेश · Buyer messages</h2>
      {error && <p className="text-sm text-danger">{error}</p>}
      {messages === null && !error && <p className="text-muted">लोड हो रहा है…</p>}
      {messages?.length === 0 && <p className="text-muted">अभी कोई संदेश नहीं · No messages yet</p>}

      <ol className="mt-6 space-y-10">
        {messages?.map((m) => (
          <MessageCard key={m.id} m={m} onReplied={() => setRefresh((n) => n + 1)} />
        ))}
      </ol>
    </div>
  );
}

function MessageCard({ m, onReplied }: { m: InboxMessage; onReplied: () => void }) {
  const [showOriginal, setShowOriginal] = useState(false);
  const level = m.shield?.level ?? "safe";
  const warnings = m.shield?.flags.filter((f) => f.code !== "payment_verified") ?? [];
  const verified = m.shield?.flags.find((f) => f.code === "payment_verified");

  function listen() {
    // Warnings first, then the message itself.
    const parts = [...warnings.map((w) => `सावधान। ${w.hi}`), `ख़रीदार ने लिखा है: ${m.translatedText ?? m.originalText}`];
    speak(parts.join(" "), "hindi");
  }

  return (
    <li className="border-t border-line pt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="eyebrow">
          {m.orderId ? `ऑर्डर · ${m.orderStatus === "COMPLETED" ? "पैसा मिल गया" : "पैसा नहीं मिला"}` : "सवाल · Question"}
          {m.productTitle && <span className="normal-case tracking-normal"> — {m.productTitle}</span>}
        </p>
        <p className="eyebrow">
          {m.channel === "mcp" && <span className="mr-2 text-indigo">AI agent</span>}
          {timeAgo(m.createdAt)}
        </p>
      </div>

      {level !== "safe" && warnings.length > 0 && (
        <div
          role="alert"
          className={`mt-4 border-l-2 px-4 py-3 ${level === "danger" ? "border-danger bg-danger-soft text-danger" : "border-marigold bg-marigold-soft text-ink"}`}
        >
          <p className="text-sm font-medium">{level === "danger" ? "धोखे की चेतावनी · Scam warning" : "ध्यान दें · Be careful"}</p>
          <ul className="mt-2 space-y-2">
            {warnings.map((w) => (
              <li key={w.code} className="text-sm leading-relaxed">
                {w.hi}
                <span className="block text-xs opacity-75">{w.en}</span>
              </li>
            ))}
          </ul>
          {m.shield?.checkedAgainstPayPal && <p className="mt-2 text-xs opacity-75">✓ PayPal से जाँचा गया · Verified with PayPal</p>}
        </div>
      )}
      {verified && (
        <p className="mt-4 border-l-2 border-leaf bg-leaf-soft px-4 py-2 text-sm text-leaf">
          {verified.hi} <span className="text-xs opacity-75">{verified.en}</span>
        </p>
      )}

      <p className="mt-5 text-lg leading-relaxed" lang="hi">
        {m.translatedText ?? m.originalText}
      </p>
      <div className="mt-3 flex gap-5 text-sm">
        <button type="button" onClick={listen} className="underline underline-offset-4">
          🔊 सुनें
        </button>
        {m.translatedText && (
          <button type="button" onClick={() => setShowOriginal((s) => !s)} className="text-muted underline underline-offset-4">
            {showOriginal ? "Hide original" : "Original (English)"}
          </button>
        )}
      </div>
      {showOriginal && <p className="mt-2 text-sm text-muted">{m.originalText}</p>}

      {m.replies.length > 0 && (
        <ul className="mt-5 space-y-3">
          {m.replies.map((r) => (
            <li key={r.id} className="border-l-2 border-ink bg-card px-4 py-3 text-sm">
              <p className="eyebrow mb-1">आपका जवाब · Your reply</p>
              <p lang="hi">{r.text}</p>
              {r.english && <p className="mt-1 text-xs text-muted">Sent in English: {r.english}</p>}
            </li>
          ))}
        </ul>
      )}

      <ReplyBox messageId={m.id} onSent={onReplied} />
    </li>
  );
}

function ReplyBox({ messageId, onSent }: { messageId: string; onSent: () => void }) {
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<Recorder | null>(null);

  async function submit(audio?: Blob) {
    setBusy(true);
    setError(null);
    const form = new FormData();
    if (text.trim()) form.append("text", text.trim());
    if (audio) form.append("audio", audio, "reply.wav");
    try {
      const res = await fetch(`/api/seller/messages/${messageId}/reply`, { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed");
      setText("");
      onSent();
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
      if (r) await submit(await r.stop());
      return;
    }
    try {
      recorder.current = await startRecording();
      setRecording(true);
    } catch {
      setError("माइक्रोफ़ोन की अनुमति दें · Allow microphone access");
    }
  }

  return (
    <div className="mt-5">
      <div className="flex items-stretch gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="अपनी भाषा में जवाब लिखें…"
          className="min-w-0 flex-1 border border-line bg-card px-4 py-3 text-sm focus:border-ink focus:outline-none"
          lang="hi"
          disabled={busy || recording}
        />
        <button
          type="button"
          onClick={toggleMic}
          disabled={busy}
          aria-label={recording ? "Stop and send voice reply" : "Reply by voice"}
          className={`w-12 shrink-0 text-paper transition ${recording ? "animate-pulse bg-danger" : "bg-ink hover:bg-ink/85"}`}
        >
          {recording ? "■" : "🎙"}
        </button>
        <button
          type="button"
          onClick={() => submit()}
          disabled={busy || recording || text.trim().length < 1}
          className="shrink-0 border border-ink px-4 text-sm transition hover:bg-ink hover:text-paper disabled:opacity-30"
        >
          {busy ? "…" : "भेजें"}
        </button>
      </div>
      <p className="mt-2 text-xs text-muted" aria-live="polite">
        {error ?? (recording ? "बोलिए… फिर ■ दबाएँ · Speak, then tap ■" : "ख़रीदार को अंग्रेज़ी में अनुवाद होकर जाएगा · Translated to English for the buyer")}
      </p>
    </div>
  );
}
