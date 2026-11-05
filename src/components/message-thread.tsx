"use client";

import { useEffect, useState } from "react";
import { downscaleImage } from "@/lib/client/media";

type Msg = {
  id: string;
  from: "buyer" | "maker";
  text: string;
  original: { text: string; language: string | null } | null;
  photos?: string[];
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
  customRequestId,
  rootId: initialRoot,
  title,
}: {
  makerName: string;
  orderId?: string;
  productId?: string;
  customRequestId?: string;
  rootId?: string;
  title?: string;
}) {
  const [rootId, setRootId] = useState(initialRoot);
  const [threadUrl, setThreadUrl] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [photos, setPhotos] = useState<{ blob: Blob; url: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Poll for the maker's replies (she may answer hours later, by voice).
  useEffect(() => {
    const q = orderId ? `orderId=${orderId}` : customRequestId ? `customRequestId=${customRequestId}` : rootId ? `thread=${rootId}` : null;
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
  }, [orderId, rootId, customRequestId]);

  async function addPhotos(files: FileList | null) {
    if (!files) return;
    const picked = [...files].slice(0, 3 - photos.length);
    const next = await Promise.all(
      picked.map(async (f) => {
        const blob = await downscaleImage(f, 1600);
        return { blob, url: URL.createObjectURL(blob) };
      }),
    ).catch(() => []);
    setPhotos((p) => [...p, ...next]);
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (text.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("text", text);
      if (orderId) form.append("orderId", orderId);
      else if (customRequestId) form.append("customRequestId", customRequestId);
      else if (productId) form.append("productId", productId);
      photos.forEach((ph, i) => form.append("photos", ph.blob, `photo-${i}.jpg`));
      const res = await fetch("/api/messages", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not send");
      setText("");
      photos.forEach((ph) => URL.revokeObjectURL(ph.url));
      setPhotos([]);
      if (!orderId && !rootId && !customRequestId) {
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
                {m.photos && m.photos.length > 0 && (
                  <div className="mt-2 flex gap-2">
                    {m.photos.map((id) => (
                      <img key={id} src={`/api/media/${id}`} alt="Attached photo" className="h-16 w-16 object-cover" />
                    ))}
                  </div>
                )}
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
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {photos.map((ph, i) => (
            <button
              key={ph.url}
              type="button"
              onClick={() => setPhotos((p) => p.filter((_, j) => j !== i))}
              title="Remove photo"
              className="relative h-14 w-14"
            >
              <img src={ph.url} alt={`Photo ${i + 1}`} className="h-full w-full object-cover" />
              <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-ink text-[10px] text-paper">×</span>
            </button>
          ))}
          {photos.length < 3 && (
            <label className="cursor-pointer border border-dashed border-muted/60 px-3 py-2 text-xs text-muted transition hover:border-ink hover:text-ink">
              📎 Add photo
              <input type="file" accept="image/*" multiple className="sr-only" onChange={(e) => addPhotos(e.target.files)} />
            </label>
          )}
          <span className="text-[11px] text-muted">e.g. damage, or proof of payment</span>
        </div>
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
