"use client";

import { useEffect, useRef, useState } from "react";
import { SellerNav, STUDIO, StudioHeader } from "@/components/seller-nav";
import { downscaleImage, speak, startRecording, type Recorder } from "@/lib/client/media";
import type { ListingDraft } from "@/lib/ai/listing";
import type { FairPrice } from "@/lib/pricing/fair-price";
import { computeEarnings, earningsSentenceEn, earningsSentenceHi, type Economics } from "@/lib/economics";

type DraftResponse = {
  draft: ListingDraft;
  voiceNoteId: string | null;
  imageIds: string[];
  suggestedPriceCents: number | null;
  inrPerUsd: number;
  fairPrice: FairPrice | null;
  economics: Economics | null;
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
  const [attributes, setAttributes] = useState<ListingDraft["attributes"] | null>(null);
  const [quantity, setQuantity] = useState("1");
  // Pilot timing: from the seller's first action to publishing.
  const startedAt = useRef<number | null>(null);

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
    startedAt.current ??= Date.now();
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
      setAttributes(data.draft.attributes);
      setQuantity("1");
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
          attributes: attributes ?? draft.attributes,
          quantity: Math.max(1, parseInt(quantity, 10) || 1),
          startedAt: startedAt.current,
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
    startedAt.current = null;
    setAttributes(null);
    setPhase({ name: "compose" });
  }

  return (
    <div className={STUDIO}>
      <SellerNav active="list" />
      <StudioHeader hi="नया सामान जोड़ें" en="Add a new piece" />

      {error && (
        <p role="alert" className="mb-6 border-l-2 border-danger bg-danger-soft px-4 py-3 text-sm text-danger">
          {error}
        </p>
      )}

      {phase.name === "compose" && (
        <div>
          <div className="grid gap-5 lg:grid-cols-2 lg:gap-8">
            <StepCard n={1} done={photos.length > 0} hi="फ़ोटो लें" en="Take photos" hintHi="2–4 फ़ोटो, दिन की रोशनी में, सादे पीछे के साथ" hintEn="2–4 photos in daylight, on a plain background">
              {photos.length === 0 ? (
                <PhotoPicker onFiles={addPhotos} large />
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2">
                  {photos.map((p, i) => (
                    <img key={p.url} src={p.url} alt={`Photo ${i + 1}`} className="aspect-square w-full border border-line object-cover" />
                  ))}
                  {photos.length < 4 && <PhotoPicker onFiles={addPhotos} />}
                </div>
              )}
            </StepCard>

            <StepCard n={2} done={!!voice} hi="बोलकर बताइए" en="Describe it by voice" hintHi="क्या है, किससे बना है, नाप, रंग और कीमत" hintEn="What it is, material, size, colour and your price">
              <div className="flex h-full min-h-56 flex-col items-center justify-center gap-4 border border-dashed border-line bg-paper/60 px-4 py-8 text-center">
                <button
                  type="button"
                  onClick={toggleRecording}
                  aria-pressed={recording}
                  aria-label={recording ? "Stop recording" : "Start recording"}
                  className={`flex h-24 w-24 items-center justify-center rounded-full text-4xl text-paper shadow-sm transition focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink ${
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
                {voice && !recording && <audio controls src={voice.url} className="w-full max-w-sm" />}
              </div>
            </StepCard>
          </div>

          <div className="sticky bottom-0 z-10 -mx-4 mt-6 flex flex-col gap-3 border-t border-line bg-paper/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:static lg:mx-0 lg:mt-8 lg:bg-transparent lg:px-0 lg:pb-0 lg:pt-6 lg:backdrop-blur-none">
            <p className="text-sm text-ink/80" aria-live="polite">
              {(() => {
                const [hi, en] =
                  photos.length > 0 && voice
                    ? ["दोनों तैयार हैं।", "Photos and voice ready."]
                    : photos.length > 0 || voice
                      ? ["दूसरा भी जोड़ें तो लिस्टिंग बेहतर बनेगी।", "Adding both gives the best listing."]
                      : ["शुरू करने के लिए फ़ोटो या आवाज़ जोड़ें।", "Add a photo or a voice note to begin."];
                return (
                  <>
                    <span lang="hi">{hi}</span>
                    <span className="block text-xs text-muted">{en}</span>
                  </>
                );
              })()}
            </p>
            <button
              type="button"
              disabled={recording || (!voice && photos.length === 0)}
              onClick={createDraft}
              className="w-full bg-ink px-8 py-4 text-base tracking-wide text-paper transition hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-30 sm:w-auto sm:min-w-72"
            >
              लिस्टिंग बनाएँ · Create listing
            </button>
          </div>
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
          attributes={attributes ?? phase.data.draft.attributes}
          onAttributes={setAttributes}
          quantity={quantity}
          onQuantity={setQuantity}
          onPublish={() => publish(phase.data)}
          onRestart={reset}
        />
      )}

      {phase.name === "done" && (
        <div className="mx-auto max-w-md space-y-4 py-10 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-leaf text-xl text-leaf">✓</div>
          <h2 className="font-display text-3xl">
            बिक्री के लिए तैयार!
            <span className="block text-base font-normal text-muted">“{phase.title}” is live</span>
          </h2>
          <p className="text-sm text-muted">
            PayPal catalog ID <code className="rounded bg-card px-1.5 py-0.5 font-mono text-xs">{phase.paypalProductId}</code>
          </p>
          <a
            href="/seller/products"
            className="block border border-ink px-4 py-4 text-sm tracking-wide transition hover:bg-ink hover:text-paper"
          >
            कारीगर का सबूत जोड़ें · Add maker evidence →
          </a>
          <button type="button" onClick={reset} className="w-full bg-ink px-4 py-4 tracking-wide text-paper">
            एक और जोड़ें · List another
          </button>
        </div>
      )}
    </div>
  );
}

/** One step of the task: numbered, titled, with a short instruction; ticks when done. Cards in a row share height. */
function StepCard({ n, done, hi, en, hintHi, hintEn, children }: { n: number; done: boolean; hi: string; en: string; hintHi: string; hintEn: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col border border-line bg-card p-5 sm:p-7">
      <div className="flex items-start gap-4">
        <span
          aria-hidden
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-sm transition ${done ? "border-leaf bg-leaf text-paper" : "border-ink text-ink"}`}
        >
          {done ? "✓" : n}
        </span>
        <div className="min-w-0">
          <h2 className="font-display text-2xl leading-tight">
            <span lang="hi">{hi}</span> <span className="whitespace-nowrap font-sans text-sm font-light text-muted">{en}</span>
          </h2>
          <p className="mt-1 text-sm text-ink/80" lang="hi">
            {hintHi}
          </p>
          <p className="text-xs text-muted">{hintEn}</p>
        </div>
      </div>
      <div className="mt-5 flex-1">{children}</div>
    </section>
  );
}

/** Add photos by tapping (camera on phones) or by dropping files (laptops). */
function PhotoPicker({ onFiles, large = false }: { onFiles: (files: FileList | null) => void; large?: boolean }) {
  const [over, setOver] = useState(false);
  return (
    <label
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onFiles(e.dataTransfer.files);
      }}
      className={`flex cursor-pointer flex-col items-center justify-center gap-2 border border-dashed text-center transition focus-within:border-ink hover:border-ink hover:text-ink ${
        over ? "border-ink bg-paper-deep/60 text-ink" : "border-muted/50 bg-paper/60 text-muted"
      } ${large ? "h-full min-h-56 px-4 py-8" : "aspect-square"}`}
    >
      <span className={large ? "text-3xl" : "text-2xl"} aria-hidden>
        +
      </span>
      <span className={large ? "text-sm" : "text-xs"} lang="hi">
        {large ? "फ़ोटो जोड़ें" : "और फ़ोटो"}
      </span>
      {large && <span className="text-xs">Tap to take or choose photos · or drop them here</span>}
      <input type="file" accept="image/*" capture="environment" multiple className="sr-only" onChange={(e) => onFiles(e.target.files)} />
    </label>
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
  attributes: ListingDraft["attributes"];
  onAttributes: (a: ListingDraft["attributes"]) => void;
  quantity: string;
  onQuantity: (v: string) => void;
  onPublish: () => void;
  onRestart: () => void;
}) {
  const { draft, imageIds, inrPerUsd, fairPrice, economics } = props.data;
  const [showTranslation, setShowTranslation] = useState(false);
  const priceNum = parseFloat(props.price);
  const attrs = [
    ...props.attributes.materials,
    ...props.attributes.colors,
    props.attributes.dimensions,
    props.attributes.origin,
    props.attributes.handmade ? "handmade" : null,
  ].filter(Boolean) as string[];

  const actions = (
    <div>
      <div className="grid grid-cols-[auto_1fr] gap-3">
        <button type="button" onClick={props.onRestart} disabled={props.busy} className="border border-ink px-5 py-3.5 transition hover:bg-ink hover:text-paper sm:py-4">
          फिर से · Redo
        </button>
        <button
          type="button"
          onClick={props.onPublish}
          disabled={props.busy}
          className="bg-ink px-4 py-3.5 tracking-wide text-paper transition hover:bg-ink/85 disabled:opacity-40 sm:py-4"
        >
          {props.busy ? "डाल रहे हैं… · Publishing…" : "PayPal पर डालें · Publish"}
        </button>
      </div>
      {!(priceNum > 0) && <p className="mt-2 text-center text-xs text-muted">Add a USD price to publish.</p>}
    </div>
  );

  return (
    <div className="space-y-5 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:items-start lg:gap-12 lg:space-y-0">
      <div className="space-y-5">
      {draft.transcript && (
        <section className="border border-line bg-card p-5 sm:p-6">
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

      <section className="space-y-5 border border-line bg-card p-5 sm:p-6">
        <p className="eyebrow">What buyers will see</p>
        <VoiceCorrection
          current={{ title: props.title, description: props.description, priceUsd: props.price, attributes: props.attributes }}
          onApply={(c, priceUsdCents) => {
            if (c.title) props.onTitle(c.title);
            if (c.description) props.onDescription(c.description);
            if (priceUsdCents) props.onPrice((priceUsdCents / 100).toFixed(2));
            if (c.quantity) props.onQuantity(String(c.quantity));
            props.onAttributes({
              ...props.attributes,
              ...(c.materials ? { materials: c.materials } : {}),
              ...(c.colors ? { colors: c.colors } : {}),
              ...(c.dimensions ? { dimensions: c.dimensions } : {}),
              ...(c.care ? { care: c.care } : {}),
            });
          }}
        />
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
        <label className="block">
          <span className="text-sm text-muted">कितने पीस हैं · Pieces available</span>
          <input
            inputMode="numeric"
            value={props.quantity}
            onChange={(e) => props.onQuantity(e.target.value.replace(/[^0-9]/g, ""))}
            className="mt-1 block w-20 border-0 border-b border-line bg-transparent px-0 py-2 focus:border-ink focus:outline-none"
          />
        </label>
        <EarningsCard economics={economics} priceUsd={props.price} inrPerUsd={inrPerUsd} />
      </section>
      </div>

      <aside className="space-y-5 lg:sticky lg:top-8">
      {draft.photoAdvice.length > 0 && (
        <section className="border border-line bg-card p-5 sm:p-6">
          <div className="flex items-baseline justify-between gap-3">
            <p className="eyebrow"><span className="deva">फ़ोटो सुझाव</span> · Photo tips</p>
            <button type="button" onClick={() => speak(draft.photoAdvice.map((a) => a.hi).join(" "), "hindi")} className="shrink-0 whitespace-nowrap text-sm underline underline-offset-4">
              🔊 सुनें
            </button>
          </div>
          <ul className="mt-3 space-y-2 text-sm">
            {draft.photoAdvice.map((a) => (
              <li key={a.en}>
                {a.hi}
                <span className="block text-xs text-muted">{a.en}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {fairPrice && <FairPriceCard fp={fairPrice} inrPerUsd={inrPerUsd} onUse={(c) => props.onPrice((c / 100).toFixed(2))} />}

      {draft.followUpQuestions.length > 0 && (
        <section className="border border-line bg-card p-5 sm:p-6 text-sm">
          <p className="mb-1 font-semibold">ख़रीदार ये भी पूछ सकते हैं · Buyers may also ask</p>
          <ul className="list-disc space-y-1 pl-5">
            {draft.followUpQuestions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="hidden lg:block">{actions}</div>
      </aside>
      <div className="sticky bottom-0 z-10 -mx-4 border-t border-line bg-paper/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:static lg:mx-0 lg:border-t-0 lg:bg-transparent lg:px-0 lg:py-0 lg:backdrop-blur-none lg:hidden">{actions}</div>
    </div>
  );
}

const wholeUsd = (c: number) => `$${Math.round(c / 100)}`;
const wholeInr = (c: number, rate: number) => `₹${Math.round((c / 100) * rate).toLocaleString("en-IN")}`;

function FairPriceCard({ fp, inrPerUsd, onUse }: { fp: FairPrice; inrPerUsd: number; onUse: (cents: number) => void }) {
  const suggested = fp.suggestedCents;
  return (
    <section className={`${fp.verdict === "under" ? "border-l-4 border-l-marigold" : ""} border border-line bg-card p-5 sm:p-6`}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow"><span className="deva">उचित दाम</span> · Fair price</p>
        <button type="button" onClick={() => speak(fp.hi, "hindi")} className="shrink-0 whitespace-nowrap text-sm underline underline-offset-4">
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

function EarningsCard({ economics, priceUsd, inrPerUsd }: { economics: Economics | null; priceUsd: string; inrPerUsd: number }) {
  const cents = Math.round((parseFloat(priceUsd) || 0) * 100);
  if (!economics) {
    return (
      <p className="border-l-2 border-marigold bg-marigold-soft px-4 py-3 text-sm" lang="hi">
        आपकी कमाई जानने के लिए पहले अपने खर्च बताइए →{" "}
        <a href="/seller/rules" className="underline underline-offset-4">
          मेरे नियम
        </a>
        <span className="block text-xs text-muted">Tell Haat your costs to see what this price leaves for your work.</span>
      </p>
    );
  }
  if (cents < 100) return null;
  const x = computeEarnings(economics, { unitPriceUsdCents: cents, pieces: 1, inrPerUsd });
  if (!("verdict" in x)) {
    return (
      <p className="border-l-2 border-marigold bg-marigold-soft px-4 py-3 text-sm" lang="hi">
        बताना बाकी है: {x.missing.join(", ")} —{" "}
        <a href="/seller/rules" className="underline underline-offset-4">
          मेरे नियम
        </a>
      </p>
    );
  }
  const tone = x.verdict === "loss" ? "border-danger bg-danger-soft" : x.verdict === "below_minimum" ? "border-marigold bg-marigold-soft" : "border-leaf bg-leaf-soft";
  const hi = earningsSentenceHi(x, economics.minimumInr);
  return (
    <section className={`border-l-2 px-4 py-3 text-sm ${tone}`}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow"><span className="deva">आपकी कमाई</span> · Left for your work</p>
        <button type="button" onClick={() => speak(hi, "hindi")} className="shrink-0 whitespace-nowrap text-sm underline underline-offset-4">
          🔊 सुनें
        </button>
      </div>
      <p className="mt-2 font-display text-2xl">
        {x.leftForWorkInr < 0 ? "−" : ""}₹{Math.abs(x.perPieceInr).toLocaleString("en-IN")}
        <span className="ml-2 font-sans text-xs text-muted">per piece, estimated</span>
      </p>
      <p className="mt-1" lang="hi">
        {hi}
      </p>
      <p className="text-xs text-muted">{earningsSentenceEn(x, economics.minimumInr)}</p>
      <p className="mt-2 text-xs text-muted">
        Buyer pays ${(x.buyerPaysUsdCents / 100).toFixed(2)} (incl. ${(x.shippingChargedUsdCents / 100).toFixed(2)} shipping) − est. PayPal fee $
        {(x.estFeeUsdCents / 100).toFixed(2)} → ≈ ₹{x.estInrAfterPayPal.toLocaleString("en-IN")} − your costs ₹{x.costs.total.toLocaleString("en-IN")} (materials{" "}
        {x.costs.materials}, packing {x.costs.packaging}, courier {x.costs.shipping}
        {x.costs.other ? `, other ${x.costs.other}` : ""})
      </p>
      <p className="mt-1 text-[11px] text-muted">{x.assumptions.join(" · ")}</p>
    </section>
  );
}

type Correction = {
  title: string | null;
  description: string | null;
  materials: string[] | null;
  colors: string[] | null;
  dimensions: string | null;
  care: string | null;
  quantity: number | null;
};

function VoiceCorrection({
  current,
  onApply,
}: {
  current: { title: string; description: string; priceUsd: string; attributes: ListingDraft["attributes"] };
  onApply: (c: Correction, priceUsdCents: number | null) => void;
}) {
  const rec = useRef<Recorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function toggle() {
    if (recording) {
      const r = rec.current;
      rec.current = null;
      setRecording(false);
      if (!r) return;
      setBusy(true);
      setNote(null);
      try {
        const form = new FormData();
        form.append("audio", await r.stop(), "correction.wav");
        form.append("current", JSON.stringify(current));
        const res = await fetch("/api/listings/correct", { method: "POST", body: form });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error);
        onApply(body.correction, body.priceUsdCents);
        setNote(body.readbackHi);
        speak(body.readbackHi, "hindi");
      } catch (e) {
        setNote((e as Error).message);
      } finally {
        setBusy(false);
      }
      return;
    }
    try {
      rec.current = await startRecording();
      setRecording(true);
    } catch {
      setNote("माइक्रोफ़ोन की अनुमति दें · Allow microphone access");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border border-dashed border-line px-4 py-3">
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        className={`px-4 py-2 text-sm text-paper disabled:opacity-40 ${recording ? "animate-pulse bg-danger" : "bg-ink hover:bg-ink/85"}`}
      >
        {recording ? "■ रुकें" : busy ? "…" : "🎙 कुछ बदलना है? बोलिए"}
      </button>
      <span className="text-xs text-muted" lang="hi">
        {note ?? "जैसे: “दाम 1800 कर दो” या “यह सूती है, रेशम नहीं” · Speak a correction"}
      </span>
    </div>
  );
}
