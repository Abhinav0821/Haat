"use client";

import { useEffect, useState } from "react";
import { SellerNav } from "@/components/seller-nav";
import { downscaleImage, speak } from "@/lib/client/media";

type Flag = { code: string; hi: string; en: string };
type Piece = {
  id: string;
  title: string;
  priceCents: number;
  image: string | null;
  passport: { status: "awaiting_photo" | "verified" | "needs_review" | "rejected"; code: string | null; verifiedAt: string | null; flags: Flag[] } | null;
};

export function Products() {
  const [pieces, setPieces] = useState<Piece[] | null>(null);
  const [slug, setSlug] = useState("");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/seller/products").catch(() => null);
      if (!cancelled && res?.ok) {
        const body = await res.json();
        setPieces(body.products);
        setSlug(body.storeSlug);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  return (
    <div className="mx-auto w-full max-w-2xl px-6 pb-24 pt-10">
      <SellerNav active="products" />
      <header className="mb-10">
        <h1 className="font-display text-4xl font-normal">
          मेरा सामान <span className="font-sans text-base font-light text-muted">My pieces</span>
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          “कारीगर का सबूत” ख़रीदारों और AI एजेंटों को दिखाता है कि यह सामान आपके पास है और फ़ोटो असली हैं।
          <span className="block text-xs">Maker Evidence shows buyers and their AI agents that you have this piece and its photos are original — not who made it.</span>
        </p>
      </header>
      {pieces === null && <p className="text-muted">लोड हो रहा है…</p>}
      <ol className="space-y-8">
        {pieces?.map((p) => (
          <PieceCard key={p.id} p={p} slug={slug} onChange={() => setRefresh((n) => n + 1)} />
        ))}
      </ol>
    </div>
  );
}

function PieceCard({ p, slug, onChange }: { p: Piece; slug: string; onChange: () => void }) {
  const [code, setCode] = useState<string | null>(p.passport?.status === "awaiting_photo" ? p.passport.code : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = p.passport?.status;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/seller/products/${p.id}/passport/start`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setCode(body.code);
      speak(`एक काग़ज़ पर बड़े अक्षरों में लिखिए: ${body.code}। काग़ज़ को सामान के बगल में रखकर पूरी फ़ोटो लीजिए।`, "hindi");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("photo", await downscaleImage(file, 1600), "proof.jpg");
      const res = await fetch(`/api/seller/products/${p.id}/passport/proof`, { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      speak(
        body.status === "verified"
          ? "बधाई हो! आपके सामान को हाथ से बने होने का प्रमाण मिल गया।"
          : body.status === "needs_review"
            ? "फ़ोटो मिल गई। कुछ बातें जाँच के लिए रुकी हैं।"
            : "प्रमाण नहीं मिल सका। नीचे लिखी बात देखकर फिर कोशिश करें।",
        "hindi",
      );
      setCode(null);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="border-t border-line pt-6">
      <div className="flex gap-4">
        <div className="h-20 w-16 shrink-0 bg-paper-deep">
          {p.image && <img src={`/api/media/${p.image}`} alt="" className="h-full w-full object-cover" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-display text-xl leading-snug">{p.title}</p>
          <p className="mt-1 text-sm text-muted">${(p.priceCents / 100).toFixed(2)}</p>
          {status === "verified" && (
            <a href={`/s/${slug}/p/${p.id}/passport`} className="mt-2 inline-block text-sm text-leaf underline underline-offset-4">
              ✓ कारीगर का सबूत · Maker evidence complete
            </a>
          )}
        </div>
      </div>

      {(status === "needs_review" || status === "rejected") && p.passport!.flags.length > 0 && (
        <div className={`mt-4 border-l-2 px-4 py-3 text-sm ${status === "rejected" ? "border-danger bg-danger-soft text-danger" : "border-marigold bg-marigold-soft"}`}>
          <p className="font-medium">{status === "rejected" ? "प्रमाण नहीं मिला · Not verified" : "जाँच के लिए रुका · Held for review"}</p>
          <ul className="mt-2 space-y-2">
            {p.passport!.flags.map((f) => (
              <li key={f.code}>
                {f.hi}
                <span className="block text-xs opacity-75">{f.en}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {status !== "verified" && !code && (
        <button type="button" onClick={start} disabled={busy} className="mt-5 bg-ink px-5 py-3 text-sm text-paper hover:bg-ink/85 disabled:opacity-40">
          {status ? "फिर कोशिश करें · Try again" : "कारीगर का सबूत जोड़ें · Add maker evidence"}
        </button>
      )}

      {code && (
        <div className="mt-5 border border-ink/80 bg-card p-5">
          <ol className="space-y-2 text-sm leading-relaxed">
            <li>
              1. एक काग़ज़ पर बड़े अक्षरों में लिखिए <span className="text-muted">· Write on paper:</span>
            </li>
          </ol>
          <p className="my-4 text-center font-display text-5xl" lang="hi">
            {code}
          </p>
          <ol start={2} className="space-y-2 text-sm leading-relaxed">
            <li>2. काग़ज़ को सामान के बगल में रखिए <span className="text-muted">· Place it next to the piece</span></li>
            <li>3. दोनों साफ़ दिखें, ऐसी एक फ़ोटो लीजिए <span className="text-muted">· Take one photo showing both</span></li>
          </ol>
          <label className={`mt-5 flex cursor-pointer items-center justify-center gap-2 bg-ink px-5 py-4 text-sm text-paper ${busy ? "opacity-50" : "hover:bg-ink/85"}`}>
            {busy ? "जाँच रहे हैं… · Checking…" : "📷 फ़ोटो लें · Take photo"}
            <input type="file" accept="image/*" capture="environment" className="sr-only" disabled={busy} onChange={(e) => upload(e.target.files?.[0])} />
          </label>
          <p className="mt-3 text-center text-[11px] text-muted">कोड 30 मिनट तक चलेगा · Code valid for 30 minutes</p>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
    </li>
  );
}
