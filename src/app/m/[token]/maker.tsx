"use client";

import { useEffect, useState } from "react";
import { Wordmark } from "@/components/craft";
import { ThemeToggle } from "@/components/theme-toggle";
import { PAGE } from "@/components/layout";
import { speak } from "@/lib/client/media";
import { LANG_INFO, MAKER_LANGS, longDay, type MakerLang } from "@/lib/i18n/languages";
import { mt } from "@/lib/i18n/maker-text";
import { plural } from "@/lib/collective/intake";
import type { MakerKey } from "@/lib/i18n/maker-source";

type Facts = {
  makesProduct: boolean;
  piecesPerWeekday: number[];
  offDates: string[];
  materialsDays: number | null;
  materialsReadyDate: string | null;
  commitments: { ref: string; pieces: number; due: string | null }[];
  askInr: number;
  floorInr: number;
  maxPieces: number | null;
  prov: { source: "maker_confirmed" | "coordinator_entered"; at: string };
};
type Part = {
  id: string;
  orderRef: string;
  version: number;
  status: "pending" | "accepted" | "declined";
  inCurrentPlan: boolean;
  orderStatus: string | null;
  termsHash: string;
  requirementsReady: boolean;
  lines: [string, string][];
  readback: string;
  termsLang: MakerLang;
  termsLangName: string;
  pieces: number;
  payInr: number;
  respondedAt: string | null;
  /** The buyer has paid for the plan with exactly this part. */
  paid: boolean;
  share: Share | null;
};
type Payment = { id: string; amountPaise: number; method: "upi" | "bank"; reference: string; reportedAt: string; status: "reported" | "confirmed" | "disputed" | "withdrawn"; respondedAt: string | null; note: string | null };
type Share = { shareId: string; owedPaise: number; confirmedPaise: number; awaitingPaise: number; disputedPaise: number; leftPaise: number; settled: boolean; payments: Payment[] };
type View = { name: string; nameHi: string | null; language: MakerLang; collective: string; product: { en: string; hi: string; mine: string }; facts: Facts; parts: Part[]; removed: { orderRef: string }[] };

const DAY_KEYS: MakerKey[] = ["day0", "day1", "day2", "day3", "day4", "day5", "day6"];

/** Text in her language, with the English underneath unless she reads English. */
function T({ k, lang, vars, small = true, className = "" }: { k: MakerKey; lang: MakerLang; vars?: Record<string, string | number>; small?: boolean; className?: string }) {
  return (
    <>
      <span lang={LANG_INFO[lang].locale}>{mt(k, lang, vars)}</span>
      {lang !== "en" && (
        <span lang="en" dir="ltr" className={`${small ? "text-xs" : ""} text-muted ${className}`}>
          {" "}
          {mt(k, "en", vars)}
        </span>
      )}
    </>
  );
}
const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const field = "w-full border-b border-line bg-transparent py-2 text-base focus:border-ink focus:outline-none";

export function MakerHome({ token }: { token: string }) {
  const [view, setView] = useState<View | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [draft, setDraft] = useState<Facts | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const res = await fetch(`/api/m/${token}`).catch(() => null);
      if (cancelled || !res) return;
      if (res.status === 404) setMissing(true);
      else if (res.ok) setView(await res.json());
    };
    void tick();
    const t = setInterval(tick, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [token]);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/m/${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error);
      setView(out);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (missing)
    return (
      <Shell>
        <p lang="hi">{mt("linkInvalid", "hi")}</p>
        <p className="mt-1 text-sm text-muted">{mt("linkInvalid", "en")}</p>
      </Shell>
    );
  if (!view) return <Shell>…</Shell>;
  const L = view.language;
  const date = (iso: string) => longDay(iso, L);
  // Unsaved edits, else her saved facts.
  const facts = draft ?? view.facts;

  const open = view.parts.filter((p) => p.inCurrentPlan && p.status !== "declined");
  const past = view.parts.filter((p) => !p.inCurrentPlan || p.status === "declined");
  const confirmed = view.facts.prov.source === "maker_confirmed";
  const set = (patch: Partial<Facts>) => {
    setSaved(false);
    setDraft({ ...facts, ...patch });
  };

  return (
    <Shell dir={LANG_INFO[L].dir}>
      <header className="grid gap-x-16 gap-y-3 lg:grid-cols-2 lg:items-end">
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <p className="eyebrow deva">{view.collective}</p>
            <label className="flex items-center gap-2 text-sm">
              <span lang={LANG_INFO[L].locale}>{mt("language", L)}</span>
              <select
                value={L}
                disabled={busy}
                onChange={(e) => void post({ action: "language", language: e.target.value })}
                className="border border-line bg-card px-2 py-1 text-sm focus:border-ink focus:outline-none"
                aria-label="Language"
              >
                {MAKER_LANGS.map((l) => (
                  <option key={l} value={l} lang={LANG_INFO[l].locale}>
                    {LANG_INFO[l].name}
                    {l !== "en" ? ` · ${LANG_INFO[l].english}` : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <h1 className="mt-3 font-display text-4xl font-normal leading-tight lg:text-5xl" lang={LANG_INFO[L].locale}>
            {mt("greeting", L, { name: L === "hi" ? (view.nameHi ?? view.name) : view.name })}
          </h1>
        </div>
        <p className="text-sm leading-relaxed text-muted lg:max-w-xl lg:justify-self-end">
          <T k="privacy" lang={L} />
        </p>
      </header>
      {!LANG_INFO[L].reviewed && (
        <p className="mt-6 border-l-2 border-marigold bg-card px-4 py-3 text-sm leading-relaxed">
          <T k="machineNote" lang={L} />
        </p>
      )}

      <section className="mt-12">
        <h2 className="font-display text-2xl">
          <T k="yourParts" lang={L} className="font-sans font-light" />
        </h2>
        {open.length === 0 && (
          <p className="mt-4 border border-dashed border-line bg-card px-5 py-8 text-center text-sm leading-relaxed text-muted">
            <T k="nothingNew" lang={L} />
          </p>
        )}
        <ul className="mt-5 space-y-6">
          {open.map((p) => (
            <li key={p.id} className="grid gap-8 border border-line bg-card p-5 sm:p-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-12 lg:p-8">
              <div className="min-w-0">
              <div className="flex items-baseline justify-between gap-3">
                <p className="eyebrow">
                  {mt("order", L)} {p.orderRef} · v{p.version}
                </p>
                <button type="button" onClick={() => speak(p.readback, LANG_INFO[p.termsLang].speech)} className="shrink-0 text-sm underline underline-offset-4" lang={LANG_INFO[L].locale}>
                  🔊 {mt("listen", L)}
                </button>
              </div>
              <p className="mt-3 text-lg leading-relaxed lg:text-xl lg:leading-relaxed" lang={LANG_INFO[p.termsLang].locale} dir={LANG_INFO[p.termsLang].dir}>
                {p.readback}
              </p>
              {p.termsLang !== L && p.status === "pending" && (
                <p className="mt-3 text-sm text-marigold">
                  <T k="otherLanguage" lang={L} vars={{ lang: p.termsLangName }} />
                </p>
              )}
              {!p.requirementsReady && (
                <p className="mt-3 text-sm text-danger">
                  <T k="requirementsMissing" lang={L} />
                </p>
              )}

              {p.status === "accepted" ? (
                <div className="mt-5 text-sm">
                  <p className="text-leaf">
                    ✓ <T k="acceptedOn" lang={L} vars={{ date: p.respondedAt ? date(p.respondedAt) : "" }} />
                  </p>
                  <PaymentState part={p} lang={L} />
                  {p.orderStatus !== "paid" && p.orderStatus !== "paying" && (
                    <button type="button" disabled={busy} onClick={() => setDeclining(p.id)} className="mt-3 text-xs text-muted underline underline-offset-4 disabled:opacity-30">
                      <T k="cantDo" lang={L} />
                    </button>
                  )}
                </div>
              ) : (
                <div className="mt-6 flex gap-3">
                  <button
                    type="button"
                    disabled={busy || !p.requirementsReady}
                    onClick={() => void post({ action: "respond", partId: p.id, hash: p.termsHash, answer: "accept" }).then((ok) => ok && speak(mt("acceptedSpoken", L), LANG_INFO[L].speech))}
                    className="flex-1 bg-ink px-5 py-3 text-paper hover:bg-ink/85 disabled:opacity-30"
                  >
                    <span lang={LANG_INFO[L].locale}>{mt("accept", L)}</span> {L !== "en" && <span className="text-xs opacity-70">Accept</span>}
                  </button>
                  <button type="button" disabled={busy} onClick={() => setDeclining(p.id)} className="flex-1 border border-ink px-5 py-3 hover:bg-ink hover:text-paper disabled:opacity-30">
                    <span lang={LANG_INFO[L].locale}>{mt("decline", L)}</span> {L !== "en" && <span className="text-xs opacity-70">Decline</span>}
                  </button>
                </div>
              )}

              {declining === p.id && (
                <form
                  className="mt-5 border-t border-line pt-5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void post({ action: "respond", partId: p.id, hash: p.termsHash, answer: "decline", note: reason.trim() || null }).then((ok) => {
                      if (ok) {
                        setDeclining(null);
                        setReason("");
                      }
                    });
                  }}
                >
                  <label className="block text-sm">
                    <T k="why" lang={L} />
                    <input value={reason} onChange={(e) => setReason(e.target.value)} className={field} lang={LANG_INFO[L].locale} />
                  </label>
                  <div className="mt-4 flex gap-5 text-sm">
                    <button type="submit" disabled={busy} className="text-danger underline underline-offset-4 disabled:opacity-30">
                      <T k="confirmDecline" lang={L} />
                    </button>
                    <button type="button" onClick={() => setDeclining(null)} className="text-muted underline underline-offset-4">
                      <T k="cancel" lang={L} />
                    </button>
                  </div>
                  <p className="mt-3 text-xs leading-relaxed text-muted">
                    <T k="declineNote" lang={L} small={false} />
                  </p>
                </form>
              )}
              </div>
              <div className="min-w-0">
                <dl className="divide-y divide-line border-t border-line text-xs lg:text-sm">
                  {p.lines.map(([k, v]) => (
                    <div key={k} className="grid grid-cols-[6.5rem_1fr] gap-3 py-2 lg:grid-cols-[8rem_1fr]">
                      <dt className="text-muted">{k}</dt>
                      <dd className="leading-relaxed">{v}</dd>
                    </div>
                  ))}
                </dl>
                {p.share && <ShareLedger share={p.share} lang={L} busy={busy} onAnswer={(paymentId, answer) => void post({ action: "payment", paymentId, answer })} />}
              </div>
            </li>
          ))}
        </ul>
        {(past.length > 0 || view.removed.length > 0) && (
          <ul className="mt-6 space-y-2 text-sm text-muted">
            {past.map((p) => (
              <li key={p.id}>
                {mt("order", L)} {p.orderRef}: <T k={p.status === "declined" ? "youDeclined" : "orderChanged"} lang={L} />
              </li>
            ))}
            {view.removed.map((r) => (
              <li key={r.orderRef}>
                {mt("order", L)} {r.orderRef}: <T k="noLongerNeeded" lang={L} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-16 border-t border-line pt-10">
        <h2 className="font-display text-2xl">
          <T k="yourFacts" lang={L} className="font-sans font-light" />
        </h2>
        <p className={`mt-2 text-sm ${confirmed ? "text-leaf" : "text-marigold"}`}>
          {confirmed ? "✓ " : "! "}
          <T k={confirmed ? "confirmedOn" : "enteredByCoordinator"} lang={L} vars={{ date: date(view.facts.prov.at) }} />
        </p>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          <T k="factsExplain" lang={L} small={false} />
        </p>

        <form
          className="mt-8 grid gap-x-16 gap-y-8 lg:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void post({ action: "facts", facts }).then((ok) => {
              if (ok) {
                setSaved(true);
                setDraft(null);
              }
            });
          }}
        >
          <div className="min-w-0 space-y-8">
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" checked={facts.makesProduct} onChange={(e) => set({ makesProduct: e.target.checked })} className="mt-1" />
            <span>
              <span lang={LANG_INFO[L].locale}>{mt("makesProduct", L, { product: L === "en" ? plural(view.product.en) : view.product.mine })}</span>
              {L !== "en" && <span className="block text-xs text-muted">{mt("makesProduct", "en", { product: plural(view.product.en) })}</span>}
            </span>
          </label>

          <fieldset>
            <legend className="text-sm">
              <T k="piecesPerDay" lang={L} />
            </legend>
            <div className="mt-3 grid grid-cols-7 gap-2" dir="ltr">
              {DAY_KEYS.map((d) => (
                <label key={d} className="text-center text-xs" lang={LANG_INFO[L].locale}>
                  {mt(d, L)}
                  <span className="sr-only"> {mt(d, "en")}</span>
                  <input
                    inputMode="numeric"
                    value={facts.piecesPerWeekday[DAY_KEYS.indexOf(d)]}
                    onChange={(e) => set({ piecesPerWeekday: facts.piecesPerWeekday.map((x, j) => (j === DAY_KEYS.indexOf(d) ? Number(e.target.value.replace(/\D/g, "") || 0) : x)) })}
                    className="mt-1 w-full border border-line bg-card py-2 text-center text-base focus:border-ink focus:outline-none"
                  />
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-6 sm:grid-cols-2">
            <label className="block text-sm">
              <T k="materials" lang={L} />
              <input
                type="date"
                value={facts.materialsReadyDate ?? ""}
                placeholder="?"
                onChange={(e) => set({ materialsReadyDate: e.target.value || null })}
                className={field}
              />
            </label>
            <label className="block text-sm">
              <T k="maxPieces" lang={L} />
              <input inputMode="numeric" value={facts.maxPieces ?? ""} onChange={(e) => set({ maxPieces: e.target.value === "" ? null : Number(e.target.value.replace(/\D/g, "")) })} className={field} />
            </label>
            <label className="block text-sm">
              <T k="ask" lang={L} />
              <input inputMode="decimal" value={facts.askInr} onChange={(e) => set({ askInr: Number(e.target.value.replace(/[^0-9.]/g, "") || 0) })} className={field} />
            </label>
            <label className="block text-sm">
              <T k="floor" lang={L} />
              <input inputMode="decimal" value={facts.floorInr} onChange={(e) => set({ floorInr: Number(e.target.value.replace(/[^0-9.]/g, "") || 0) })} className={field} />
            </label>
          </div>
          </div>

          <div className="min-w-0 space-y-8">
          <fieldset>
            <legend className="text-sm">
              <T k="otherPromises" lang={L} />
            </legend>
            <ul className="mt-2 space-y-3">
              {facts.commitments.map((c, i) => (
                <li key={i} className="grid grid-cols-[1fr_auto] items-end gap-x-4 gap-y-2 text-sm sm:flex sm:flex-wrap">
                  <input value={c.ref} placeholder={`${mt("forWhom", L)}${L !== "en" ? ` / ${mt("forWhom", "en")}` : ""}`} onChange={(e) => set({ commitments: facts.commitments.map((x, j) => (j === i ? { ...x, ref: e.target.value } : x)) })} className="min-w-0 flex-1 border-b border-line bg-transparent py-2 focus:border-ink focus:outline-none" aria-label="What" />
                  <label lang={LANG_INFO[L].locale} className="flex items-center gap-2">
                    {mt("pieces", L)}
                    <input inputMode="numeric" value={c.pieces} onChange={(e) => set({ commitments: facts.commitments.map((x, j) => (j === i ? { ...x, pieces: Number(e.target.value.replace(/\D/g, "") || 0) } : x)) })} className="w-14 border-b border-line bg-transparent py-2 text-center focus:border-ink focus:outline-none" />
                  </label>
                  <label lang={LANG_INFO[L].locale} className="flex items-center gap-2">
                    {mt("byWhen", L)}
                    <input type="date" value={c.due ?? ""} onChange={(e) => set({ commitments: facts.commitments.map((x, j) => (j === i ? { ...x, due: e.target.value || null } : x)) })} className="border-b border-line bg-transparent py-1.5 focus:border-ink focus:outline-none" />
                  </label>
                  <button type="button" onClick={() => set({ commitments: facts.commitments.filter((_, j) => j !== i) })} className="text-xs text-muted underline underline-offset-4" lang={LANG_INFO[L].locale}>
                    {mt("remove", L)}
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" onClick={() => set({ commitments: [...facts.commitments, { ref: "", pieces: 1, due: null }] })} className="mt-3 text-sm underline underline-offset-4">
              <T k="addPromise" lang={L} />
            </button>
          </fieldset>

          <div className="flex flex-wrap items-center gap-4 border-t border-line pt-6">
            <button type="submit" disabled={busy} className="bg-ink px-6 py-3 text-paper hover:bg-ink/85 disabled:opacity-30">
              <span lang={LANG_INFO[L].locale}>{mt("confirmFacts", L)}</span> {L !== "en" && <span className="text-xs opacity-70">Confirm</span>}
            </button>
            {saved && (
              <span className="text-sm text-leaf" lang={LANG_INFO[L].locale}>
                ✓ {mt("confirmedDone", L)}
              </span>
            )}
          </div>
          </div>
        </form>
      </section>

      {error && (
        <p className="mt-8 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
    </Shell>
  );
}

/** Whether she may start: only once the buyer has paid for exactly this part. */
function PaymentState({ part, lang }: { part: Part; lang: MakerLang }) {
  const [k, border]: [MakerKey, string] = part.paid ? ["paid", "border-leaf"] : part.orderStatus === "paying" ? ["paying", "border-line"] : ["unpaid", "border-marigold"];
  return (
    <p className={`mt-3 border-l-2 ${border} pl-3 leading-relaxed`}>
      <span lang={LANG_INFO[lang].locale}>{mt(k, lang)}</span>
      {lang !== "en" && <span className="block text-xs text-muted">{mt(k, "en")}</span>}
    </p>
  );
}

/** What the collective owes her, and each payment it reports: hers to confirm. */
function ShareLedger({ share, lang: L, busy, onAnswer }: { share: Share; lang: MakerLang; busy: boolean; onAnswer: (paymentId: string, answer: "confirm" | "dispute") => void }) {
  const shown = share.payments.filter((x) => x.status !== "withdrawn");
  const due = share.owedPaise - share.confirmedPaise;
  return (
    <div className="mt-6 border-t border-line pt-5">
      <h3 className="font-display text-lg">
        <T k="yourPay" lang={L} className="font-sans font-light" />
      </h3>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted">
            <T k="owed" lang={L} small={false} />
          </dt>
          <dd>{rupees(share.owedPaise)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">
            <T k="received" lang={L} small={false} />
          </dt>
          <dd className={share.confirmedPaise ? "text-leaf" : ""}>{rupees(share.confirmedPaise)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">
            <T k="stillDue" lang={L} small={false} />
          </dt>
          <dd className={due ? "text-marigold" : "text-leaf"}>{share.settled ? `✓ ${mt("allReceived", L)}` : rupees(due)}</dd>
        </div>
      </dl>
      {shown.length > 0 && (
        <ul className="mt-4 divide-y divide-line border-y border-line text-sm">
          {shown.map((x) => (
            <li key={x.id} className="py-3">
              <p>
                {rupees(x.amountPaise)} <span className="text-muted">· {x.method === "upi" ? "UPI" : mt("bank", L)} </span>
                <span className="break-all font-mono text-xs" dir="ltr">{x.reference}</span>
                <span className="text-xs text-muted"> · {longDay(x.reportedAt, L)}</span>
              </p>
              {x.status === "confirmed" && (
                <p className="mt-1 text-xs text-leaf">
                  ✓ <T k="youConfirmedReceipt" lang={L} small={false} />
                </p>
              )}
              {x.status !== "confirmed" && (
                <>
                  <p className="mt-1 text-xs text-muted">
                    <span lang={LANG_INFO[L].locale}>{mt(x.status === "disputed" ? "disputedNote" : "reportedNote", L)}</span>
                    {L !== "en" && <span className="block">{mt(x.status === "disputed" ? "disputedNote" : "reportedNote", "en")}</span>}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-3">
                    <button type="button" disabled={busy} onClick={() => onAnswer(x.id, "confirm")} className="bg-ink px-4 py-2 text-paper hover:bg-ink/85 disabled:opacity-30">
                      <span lang={LANG_INFO[L].locale}>{mt(x.status === "disputed" ? "nowReceived" : "yesReceived", L)}</span> {L !== "en" && <span className="text-xs opacity-70">Received</span>}
                    </button>
                    {x.status === "reported" && (
                      <button type="button" disabled={busy} onClick={() => onAnswer(x.id, "dispute")} className="border border-ink px-4 py-2 hover:bg-ink hover:text-paper disabled:opacity-30">
                        <span lang={LANG_INFO[L].locale}>{mt("notReceived", L)}</span> {L !== "en" && <span className="text-xs opacity-70">Not received</span>}
                      </button>
                    )}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs leading-relaxed text-muted">
        <span lang={LANG_INFO[L].locale}>{mt("onlyYou", L)}</span>
        {L !== "en" && <span className="block">{mt("onlyYou", "en")}</span>}
      </p>
    </div>
  );
}

function Shell({ children, dir = "ltr" }: { children: React.ReactNode; dir?: "ltr" | "rtl" }) {
  return (
    <div className={`${PAGE} pb-24 pt-8`} dir={dir}>
      <nav className="mb-10 flex items-center justify-between gap-3 border-b border-line pb-5">
        <Wordmark />
        <ThemeToggle />
      </nav>
      {children}
    </div>
  );
}
