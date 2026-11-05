"use client";

import { useEffect, useState } from "react";

type Msg = {
  id: string;
  from: "buyer" | "maker";
  text: string;
  original: { text: string; language: string | null } | null;
  at: string;
};

/**
 * Buyer-side conversation with the maker. Works for an order (orderId) or a
 * pre-sale question (productId → starts a thread; rootId → existing thread).
 */
export function MessageThread({
  makerName,
  orderId,
  productId,
  rootId: initialRoot,
  title,
}: {
  makerName: string;
  orderId?: string;
  productId?: string;
  rootId?: string;
  title?: string;
}) {
  const [rootId, setRootId] = useState(initialRoot);
  const [threadUrl, setThreadUrl] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Poll for the maker's replies (she may answer hours later, by voice).
  useEffect(() => {
    const q = orderId ? `orderId=${orderId}` : rootId ? `thread=${rootId}` : null;
    if (!q) return;
    let cancelled = false;
    const tick = async () => {
      const res = await fetch(`/api/messages?${q}`).catch(() => null);
      if (!cancelled && res?.ok) setMessages((await res.json()).messages);
    };
    void tick();
    const t = setInterval(tick, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [orderId, rootId]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (text.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, ...(orderId ? { orderId } : { productId }) }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not send");
      setText("");
      if (!orderId && !rootId) {
        setRootId(body.message.id);
        setThreadUrl(body.threadUrl);
      }
      setMessages((m) => [...m, body.message]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <p className="eyebrow">{title ?? `Ask ${makerName}`}</p>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        Write in English — {makerName} reads it in her own language and replies in her own words, translated for you.
      </p>

      {messages.length > 0 && (
        <ol className="mt-6 space-y-4">
          {messages.map((m) => (
            <li key={m.id} className={m.from === "buyer" ? "pl-10" : "pr-10"}>
              <div className={m.from === "buyer" ? "bg-paper-deep/60 px-4 py-3" : "border-l-2 border-ink bg-card px-4 py-3"}>
                <p className="eyebrow mb-1">{m.from === "buyer" ? "You" : makerName}</p>
                <p className="text-sm leading-relaxed">{m.text}</p>
                {m.original && (
                  <p className="mt-2 text-xs text-muted" lang="hi">
                    {m.original.text}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      <form onSubmit={send} className="mt-6">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder={orderId ? `Message ${makerName} about your order…` : `e.g. How wide is it? Is the colour fast?`}
          className="w-full resize-none border border-line bg-card px-4 py-3 text-sm focus:border-ink focus:outline-none"
        />
        <div className="mt-3 flex items-center justify-between gap-4">
          <p className="text-xs text-muted" aria-live="polite">
            {error ?? (threadUrl ? (
              <>
                Sent. Bookmark{" "}
                <a href={threadUrl} className="underline underline-offset-4">
                  this conversation
                </a>{" "}
                to see her reply.
              </>
            ) : null)}
          </p>
          <button
            type="submit"
            disabled={busy || text.trim().length < 2}
            className="shrink-0 border border-ink px-6 py-2.5 text-sm tracking-wide transition hover:bg-ink hover:text-paper disabled:opacity-30"
          >
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
      </form>
    </section>
  );
}
