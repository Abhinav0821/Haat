"use client";

import { useEffect, useRef, useState } from "react";
import { SellerNav } from "@/components/seller-nav";
import { downscaleImage, speak, startRecording, type Recorder } from "@/lib/client/media";
import type { ListingDraft } from "@/lib/ai/listing";
import type { FairPrice } from "@/lib/pricing/fair-price";

type DraftResponse = {
  draft: ListingDraft;
  voiceNoteId: string | null;
  imageIds: string[];
  suggestedPriceCents: number | null;
  inrPerUsd: number;
  fairPrice: FairPrice | null;
};

type Photo = { blob: Blob; url: string };
type Phase =
  | { name: "compose" }
  | { name: "thinking" }
  | { name: "review"; data: DraftResponse }
  | { name: "publishing"; data: DraftResponse }
  | { name: "done"; paypalProductId: string; title: string };

export function SpeakToList() {
  const [phase, setPhase] = useState<Phase>({ name: "compose" });
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [voice, setVoice] = useState<{ blob: Blob; url: string } | null>(null);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<Recorder | null>(null);
  // Idempotency key for publishing; created per draft in an event handler (not during render).
  const draftId = useRef<string | null>(null);

  // Editable fields during review
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  useEffect(() => () => recorder.current?.cancel(), []);

  async function addPhotos(files: FileList | null) {
    if (!files) return;
    setError(null);
    const room = 4 - photos.length;
    const picked = [...files].slice(0, room);
    try {
      const next = await Promise.all(
        picked.map(async (f) => {
          const blob = await downscaleImage(f);
          return { blob, url: URL.createObjectURL(blob) };
        }),
      );
      setPhotos((p) => [...p, ...next]);
    } catch {
      setError("यह फ़ोटो नहीं खुल सकी · That photo couldn't be opened");
    }
  }

  async function toggleRecording() {
    setError(null);
    if (recording) {
      const r = recorder.current;
      recorder.current = null;
      setRecording(false);
      if (!r) return;
      try {
        const blob = await r.stop();
        setVoice({ blob, url: URL.createObjectURL(blob) });
      } catch {
        setError("आवाज़ रिकॉर्ड नहीं हुई · Recording failed, please try again");
      }
      return;
    }
    try {
      recorder.current = await startRecording();
      setSeconds(0);
      setRecording(true);
    } catch {
      setError("माइक्रोफ़ोन की अनुमति दें · Please allow microphone access");
    }
  }

  async function createDraft() {
    setError(null);
    draftId.current = crypto.randomUUID();
    setPhase({ name: "thinking" });
    const form = new FormData();
    if (voice) form.append("audio", voice.blob, "voice.wav");
    photos.forEach((p, i) => form.append("images", p.blob, `photo-${i}.jpg`));
    try {
      const res = await fetch("/api/listings/draft", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Something went wrong");
      const data = body as DraftResponse;
      setTitle(data.draft.title);
      setDescription(data.draft.description);
      setPrice(data.suggestedPriceCents ? (data.suggestedPriceCents / 100).toFixed(2) : "");
      setPhase({ name: "review", data });
      if (data.draft.spokenSummary) speak(data.draft.spokenSummary, data.draft.sellerLanguage);
    } catch (e) {
      setError((e as Error).message);
      setPhase({ name: "compose" });
    }
  }

  async function publish(data: DraftResponse) {
    const priceCents = Math.round(parseFloat(price) * 100);
    if (!Number.isFinite(priceCents) || priceCents < 100) {
      setError("कृपया डॉलर में कीमत डालें · Please enter a price in USD (at least $1)");
      return;
    }
    setError(null);
    setPhase({ name: "publishing", data });
    const { draft } = data;
    try {
      const res = await fetch("/api/listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draftId: draftId.current,
          title,
          description,
          priceCents,
          category: draft.category,
          attributes: draft.attributes,
          imageIds: data.imageIds,
          voiceNoteId: data.voiceNoteId,
          sellerTranscript: draft.transcript || null,
          sellerTranslation: draft.translation || null,
          sellerLanguage: draft.sellerLanguage === "none" ? null : draft.sellerLanguage,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Publishing failed");
      setPhase({ name: "done", paypalProductId: body.paypalProductId, title });
      speak("आपका सामान अब दुनिया भर में बिक्री के लिए है।", "hindi");
    } catch (e) {
      setError((e as Error).message);
      setPhase({ name: "review", data });
    }
  }

  function reset() {
    photos.forEach((p) => URL.revokeObjectURL(p.url));
    if (voice) URL.revokeObjectURL(voice.url);
    setPhotos([]);
    setVoice(null);
    setError(null);
    draftId.current = null;
    setPhase({ name: "compose" });
  }

  return (
    <div className="mx-auto w-full max-w-md px-6 pb-20 pt-10">
      <SellerNav active="list" />
      <header className="mb-10">
        <h1 className="font-display text-4xl font-normal leading-tight">
          नया सामान जोड़ें
          <span className="mt-1 block font-sans text-base font-light text-muted">Add a new piece</span>
        </h1>
      </header>

      {error && (
        <p role="alert" className="mb-6 border-l-2 border-danger bg-danger-soft px-4 py-3 text-sm text-danger">
          {error}
        </p>
      )}

      {phase.name === "compose" && (
        <div className="space-y-6">
          <section>
            <StepLabel n={1} hi="फ़ोटो लें" en="Take photos" />
            <div className="grid grid-cols-4 gap-2">
              {photos.map((p, i) => (
                <img key={p.url} src={p.url} alt={`Photo ${i + 1}`} className="aspect-square w-full object-cover" />
              ))}
              {photos.length < 4 && (
                <label className="flex aspect-square cursor-pointer flex-col items-center justify-center border border-dashed border-muted/50 bg-card text-muted transition hover:border-ink hover:text-ink">
                  <span className="text-2xl" aria-hidden>
                    +
                  </span>
                  <span className="text-[11px]">फ़ोटो · Photo</span>
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    multiple
                    className="sr-only"
                    onChange={(e) => addPhotos(e.target.files)}
                  />
                </label>
              )}
            </div>
          </section>

          <section>
            <StepLabel n={2} hi="अपनी भाषा में बताइए" en="Describe it in your language" />
            <p className="mb-4 text-sm text-muted">
              क्या है, किससे बना है, नाप, रंग, और कीमत।
              <span className="block">What it is, material, size, colour and your price.</span>
            </p>
            <div className="flex flex-col items-center gap-3">
              <button
                type="button"
                onClick={toggleRecording}
                aria-pressed={recording}
                aria-label={recording ? "Stop recording" : "Start recording"}
                className={`flex h-28 w-28 items-center justify-center rounded-full text-4xl text-paper transition ${
                  recording ? "animate-pulse bg-danger" : "bg-ink hover:bg-ink/85"
                }`}
              >
                {recording ? "■" : "🎙"}
              </button>
              <p className="text-sm text-muted" aria-live="polite">
                {recording
                  ? `बोलिए… ${seconds}s · Listening — tap to stop`
                  : voice
                    ? "रिकॉर्ड हो गया ✓ · Recorded — tap to record again"
                    : "टैप करें और बोलें · Tap and speak"}
              </p>
              {voice && !recording && <audio controls src={voice.url} className="w-full" />}
            </div>
          </section>

          <button
            type="button"
            disabled={recording || (!voice && photos.length === 0)}
            onClick={createDraft}
            className="w-full bg-ink px-4 py-4 text-base tracking-wide text-paper transition hover:bg-ink/85 disabled:opacity-30"
          >
            लिस्टिंग बनाएँ · Create listing
          </button>
        </div>
      )}

      {phase.name === "thinking" && (
        <div className="flex flex-col items-center gap-4 py-16 text-center" aria-live="polite">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-line border-t-ink" />
          <p className="font-display text-2xl">सुन रहे हैं और लिख रहे हैं…</p>
          <p className="text-sm text-muted">Listening to you and writing your listing…</p>
        </div>
      )}

      {(phase.name === "review" || phase.name === "publishing") && (
        <Review
          data={phase.data}
          busy={phase.name === "publishing"}
          title={title}
          description={description}
          price={price}
          onTitle={setTitle}
          onDescription={setDescription}
          onPrice={setPrice}
          onPublish={() => publish(phase.data)}
          onRestart={reset}
        />
      )}

      {phase.name === "done" && (
        <div className="space-y-4 py-10 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-leaf text-xl text-leaf">✓</div>
          <h2 className="font-display text-3xl">
            बिक्री के लिए तैयार!
            <span className="block text-base font-normal text-muted">“{phase.title}” is live</span>
          </h2>
          <p className="text-sm text-muted">
            PayPal catalog ID <code className="rounded bg-card px-1.5 py-0.5 font-mono text-xs">{phase.paypalProductId}</code>
          </p>
          <button type="button" onClick={reset} className="w-full bg-ink px-4 py-4 tracking-wide text-paper">
            एक और जोड़ें · List another
          </button>
        </div>
      )}
    </div>
  );
}

function StepLabel({ n, hi, en }: { n: number; hi: string; en: string }) {
  return (
    <h2 className="mb-4 flex items-baseline gap-3 font-display text-2xl">
      <span className="eyebrow shrink-0 text-ink">0{n}</span>
      {hi}
      <span className="font-sans text-sm font-light text-muted">{en}</span>
    </h2>
  );
}

function Review(props: {
  data: DraftResponse;
  busy: boolean;
  title: string;
  description: string;
  price: string;
  onTitle: (v: string) => void;
  onDescription: (v: string) => void;
  onPrice: (v: string) => void;
  onPublish: () => void;
  onRestart: () => void;
}) {
  const { draft, imageIds, inrPerUsd, fairPrice } = props.data;
  const [showTranslation, setShowTranslation] = useState(false);
  const priceNum = parseFloat(props.price);
  const attrs = [
    ...draft.attributes.materials,
    ...draft.attributes.colors,
    draft.attributes.dimensions,
    draft.attributes.origin,
    draft.attributes.handmade ? "handmade" : null,
  ].filter(Boolean) as string[];

  return (
    <div className="space-y-5">
      {draft.transcript && (
        <section className="border-l-2 border-ink bg-card p-5">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="font-semibold">
              क्या मैंने सही समझा?
              <span className="block text-sm font-normal text-muted">Did I understand you?</span>
            </h2>
            {draft.spokenSummary && (
              <button
                type="button"
                onClick={() => speak(draft.spokenSummary, draft.sellerLanguage)}
                className="shrink-0 rounded-full border border-ink px-4 py-2 text-sm transition hover:bg-ink hover:text-paper"
              >
                🔊 सुनें
              </button>
            )}
          </div>
          <p className="leading-relaxed">“{draft.transcript}”</p>
          <button type="button" onClick={() => setShowTranslation((s) => !s)} className="mt-3 text-sm text-muted underline underline-offset-4 hover:text-ink">
            {showTranslation ? "Hide English" : "Show English translation"}
          </button>
          {showTranslation && <p className="mt-2 text-sm text-muted">{draft.translation}</p>}
        </section>
      )}

      <section className="space-y-5 border border-line bg-card p-5">
        <p className="eyebrow">What buyers will see</p>
        {imageIds.length > 0 && (
          <div className="flex gap-2 overflow-x-auto">
            {imageIds.map((id) => (
              <img key={id} src={`/api/media/${id}`} alt="" className="h-24 w-24 shrink-0 object-cover" />
            ))}
          </div>
        )}
        <label className="block">
          <span className="text-sm text-muted">Title</span>
          <input
            value={props.title}
            onChange={(e) => props.onTitle(e.target.value)}
            className="mt-1 w-full border-0 border-b border-line bg-transparent px-0 py-2 focus:border-ink focus:outline-none font-semibold"
          />
        </label>
        <label className="block">
          <span className="text-sm text-muted">Description</span>
          <textarea
            value={props.description}
            onChange={(e) => props.onDescription(e.target.value)}
            rows={4}
            className="mt-1 w-full border-0 border-b border-line bg-transparent px-0 py-2 focus:border-ink focus:outline-none text-sm leading-relaxed"
          />
        </label>
        {attrs.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {attrs.map((a) => (
              <li key={a} className="border border-line px-3 py-1 text-xs capitalize text-muted">
                {a}
              </li>
            ))}
          </ul>
        )}
        <label className="block">
          <span className="text-sm text-muted">कीमत · Price (USD)</span>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-lg">$</span>
            <input
              inputMode="decimal"
              value={props.price}
              onChange={(e) => props.onPrice(e.target.value.replace(/[^0-9.]/g, ""))}
              className="w-32 border-0 border-b border-line bg-transparent px-0 py-2 focus:border-ink focus:outline-none text-lg font-semibold"
            />
            {Number.isFinite(priceNum) && priceNum > 0 && (
              <span className="text-sm text-muted">≈ ₹{Math.round(priceNum * inrPerUsd).toLocaleString("en-IN")}</span>
            )}
          </div>
          {draft.statedPrice && (
            <span className="mt-1 block text-xs text-muted">
              You said {draft.statedPrice.currency === "INR" ? "₹" : draft.statedPrice.currency + " "}
              {draft.statedPrice.amount.toLocaleString("en-IN")} · converted at ₹{inrPerUsd} = $1
            </span>
          )}
        </label>
      </section>

      {fairPrice && <FairPriceCard fp={fairPrice} inrPerUsd={inrPerUsd} onUse={(c) => props.onPrice((c / 100).toFixed(2))} />}

      {draft.followUpQuestions.length > 0 && (
        <section className="border border-line p-5 text-sm">
          <p className="mb-1 font-semibold">ख़रीदार ये भी पूछ सकते हैं · Buyers may also ask</p>
          <ul className="list-disc space-y-1 pl-5">
            {draft.followUpQuestions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex gap-3">
        <button type="button" onClick={props.onRestart} disabled={props.busy} className="border border-ink px-5 py-4 transition hover:bg-ink hover:text-paper">
          फिर से · Redo
        </button>
        <button
          type="button"
          onClick={props.onPublish}
          disabled={props.busy}
          className="flex-1 bg-ink px-4 py-4 tracking-wide text-paper transition hover:bg-ink/85 disabled:opacity-40"
        >
          {props.busy ? "डाल रहे हैं… · Publishing…" : "PayPal पर डालें · Publish"}
        </button>
      </div>
      {!(priceNum > 0) && <p className="text-center text-xs text-muted">Add a USD price to publish.</p>}
    </div>
  );
}

const wholeUsd = (c: number) => `$${Math.round(c / 100)}`;
const wholeInr = (c: number, rate: number) => `₹${Math.round((c / 100) * rate).toLocaleString("en-IN")}`;

function FairPriceCard({ fp, inrPerUsd, onUse }: { fp: FairPrice; inrPerUsd: number; onUse: (cents: number) => void }) {
  const suggested = fp.suggestedCents;
  return (
    <section className={`border-l-2 ${fp.verdict === "under" ? "border-marigold" : "border-line"} bg-card p-5`}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow">उचित दाम · Fair price</p>
        <button type="button" onClick={() => speak(fp.hi, "hindi")} className="text-sm underline underline-offset-4">
          🔊 सुनें
        </button>
      </div>
      <p className="mt-3 font-display text-3xl">
        {wholeUsd(fp.lowCents)}–{wholeUsd(fp.highCents)}
        <span className="ml-2 font-sans text-sm font-light text-muted">
          ≈ {wholeInr(fp.lowCents, inrPerUsd)}–{wholeInr(fp.highCents, inrPerUsd)}
        </span>
      </p>
      <p className="mt-2 text-sm leading-relaxed" lang="hi">
        {fp.hi}
      </p>
      <p className="mt-1 text-xs text-muted">{fp.en}</p>
      {suggested !== null && (
        <button
          type="button"
          onClick={() => onUse(suggested)}
          className="mt-4 bg-ink px-5 py-3 text-sm text-paper transition hover:bg-ink/85"
        >
          {wholeUsd(suggested)} रखें · Use {wholeUsd(suggested)}
        </button>
      )}
      <ul className="mt-5 divide-y divide-line border-t border-line text-xs">
        {fp.examples.map((e) => (
          <li key={e.url} className="flex justify-between gap-3 py-2">
            <a href={e.url} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate hover:underline">
              {e.title}
            </a>
            <span className="shrink-0 text-muted">
              {wholeUsd(e.priceCents)} · {e.domain}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] text-muted">Live prices of similar products via Channel3. You decide the price.</p>
    </section>
  );
}
