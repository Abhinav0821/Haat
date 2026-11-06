import { and, desc, eq, ne, sql } from "drizzle-orm";
import { db, schema, withTx, type DB, type Tx } from "@/db";
import { hearBuyerRequest, hearSellerAnswer, optionsFrom, specFrom } from "@/lib/ai/custom";
import { readEconomics, type Economics } from "@/lib/economics";
import { env } from "@/lib/env";
import { isCalendarDate } from "@/lib/calendar-date";
import { logEvent } from "@/lib/events";
import {
  AgreementError,
  approveAgreement,
  buildTerms,
  effectiveBacklog,
  lapseIfExpired,
  reconcileIfStale,
  type FinalCheck,
  payableProblem,
  proposeAgreement,
  termsHi,
  termsLinesEn,
  type Terms,
} from "./agreement";
import { capacityProof } from "./capacity-proof";
import { completionDate, deliveryEstimate, evaluateCounter, isoDate, maxQuantityByDeadline, minimumUnitPriceUsdCents, validateOption, type CounterResult, type CustomSpec, type Option, type OptionVerdict } from "./quote";

/**
 * Custom orders, end to end:
 *   buyer request (AI → spec) → maker answers by voice (AI → options)
 *   → code checks each option against HER rules → she sends the valid ones
 *   → buyer picks one (or counters; code answers) → immutable agreement
 *   → both approve that exact version → PayPal checkout for exactly those terms.
 */

type RequestRow = typeof schema.customRequests.$inferSelect;
type AgreementRow = typeof schema.agreements.$inferSelect;
type Counter = { quantity: number; totalBudgetUsdCents: number; result: CounterResult; at: string };

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const hiDate = (iso: string) => new Date(iso).toLocaleDateString("hi-IN", { day: "numeric", month: "long", timeZone: "UTC" });
const ORDINAL_HI = ["पहला", "दूसरा", "तीसरा", "चौथा"];

async function loadStore(storeId: string) {
  const d = await db();
  const [store] = await d.select().from(schema.stores).where(eq(schema.stores.id, storeId));
  if (!store) throw new AgreementError("shop not found", 404);
  return store;
}

/** Her rules with `backlogPieces` raised to include accepted agreements (other than this request's). */
async function rulesNow(storeId: string, requestId?: string): Promise<{ e: Economics | null; inrPerUsd: number }> {
  const store = await loadStore(storeId);
  const base = readEconomics(store.policy);
  const inrPerUsd = env().INR_PER_USD;
  if (!base) return { e: null, inrPerUsd };
  return { e: { ...base, backlogPieces: await effectiveBacklog(storeId, base, { excludeRequestId: requestId }) }, inrPerUsd };
}

export async function loadRequest(id: string): Promise<RequestRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AgreementError("request not found", 404);
  const d = await db();
  const [r] = await d.select().from(schema.customRequests).where(eq(schema.customRequests.id, id));
  if (!r) throw new AgreementError("request not found", 404);
  return r;
}

async function currentAgreement(requestId: string): Promise<AgreementRow | undefined> {
  const d = await db();
  const [a] = await d
    .select()
    .from(schema.agreements)
    .where(and(eq(schema.agreements.requestId, requestId), ne(schema.agreements.status, "superseded")))
    .orderBy(desc(schema.agreements.version));
  return reconcileIfStale(await lapseIfExpired(a));
}

/**
 * Do these exact terms still fit her rules? Earnings use the payment the terms
 * actually contain (their own shipping charge), with her CURRENT costs; capacity
 * uses work already booked by other agreements. Run inside a transaction (`tx`)
 * when it guards a state change.
 */
async function termsProblem(r: RequestRow, t: Terms, tx?: Tx | DB, now = new Date()): Promise<string | null> {
  const d = tx ?? (await db());
  const [store] = await d.select().from(schema.stores).where(eq(schema.stores.id, r.storeId));
  const base = readEconomics(store?.policy);
  if (!base) return "Save your rules first.";
  const backlog = await effectiveBacklog(r.storeId, base, { excludeRequestId: r.id, tx: d, now });
  const e = { ...base, backlogPieces: backlog, shippingChargeUsdCents: t.shippingUsdCents };
  const v = validateOption(
    { quantity: t.quantity, unitPriceUsdCents: t.unitPriceUsdCents, completionBy: t.completionBy, colors: null, materials: null, note: null },
    specOf(r),
    e,
    { now, inrPerUsd: env().INR_PER_USD },
  );
  return v.status === "blocked" ? v.checks.filter((c) => c.blocking).map((c) => c.en).join(" ") : null;
}

/** The check that runs atomically when terms become fully approved (whoever approves last). */
const finalCheckFor = (r: RequestRow): FinalCheck => (tx, a) => termsProblem(r, a.terms as Terms, tx);

// ── Buyer side ──────────────────────────────────────────────────────────────

export function requestSummaryHi(
  spec: CustomSpec,
  itemHi: string,
  buyerName: string | null,
  inrPerUsd: number,
  wordsHi: { colors?: string[]; materials?: string[] } = {},
): string {
  // Hindi words only when the model gave one per item (otherwise the English is safer than a mismatch).
  const colors = wordsHi.colors?.length === spec.colors.length ? wordsHi.colors : spec.colors;
  const materials = wordsHi.materials?.length === spec.materials.length ? wordsHi.materials : spec.materials;
  const parts = [`${buyerName ?? "एक ख़रीदार"} को ${spec.quantity} पीस ${itemHi || spec.item} चाहिए`];
  if (colors.length) parts.push(`रंग: ${colors.join(", ")}`);
  if (materials.length) parts.push(`कपड़ा/सामान: ${materials.join(", ")}`);
  let s = parts.join(", ") + "।";
  if (spec.deadline) s += ` ${hiDate(spec.deadline)} तक पहुँचने चाहिए।`;
  if (spec.budgetUsdCents) s += ` बजट: कुल ${(spec.budgetUsdCents / 100).toFixed(0)} डॉलर (लगभग ₹${Math.round((spec.budgetUsdCents / 100) * inrPerUsd).toLocaleString("en-IN")})।`;
  return s;
}

export async function createCustomRequest(
  storeId: string,
  input: { buyerText: string; buyerName?: string | null; buyerEmail?: string | null; channel: "web" | "mcp" },
  deps: { hear?: typeof hearBuyerRequest } = {},
) {
  const text = input.buyerText.trim().slice(0, 2000);
  if (text.length < 10) throw new AgreementError("Please describe what you'd like made.", 400);
  const now = new Date();
  const inrPerUsd = env().INR_PER_USD;
  const heard = await (deps.hear ?? hearBuyerRequest)(text, now);
  const spec = specFrom(heard, inrPerUsd);
  const d = await db();
  const [row] = await d
    .insert(schema.customRequests)
    .values({
      storeId,
      channel: input.channel,
      buyerName: input.buyerName?.trim().slice(0, 80) || null,
      buyerEmail: input.buyerEmail?.trim().slice(0, 120) || null,
      buyerText: text,
      spec: { ...spec, itemHi: heard.itemHi, colorsHi: heard.colorsHi, materialsHi: heard.materialsHi, otherWishes: heard.otherWishes, otherWishesHi: heard.otherWishesHi },
      summaryHi: requestSummaryHi(spec, heard.itemHi, input.buyerName?.trim() || null, inrPerUsd, { colors: heard.colorsHi, materials: heard.materialsHi }),
    })
    .returning();
  await logEvent("custom_request_created", { requestId: row.id, channel: input.channel, quantity: spec.quantity, deadline: !!spec.deadline, budget: !!spec.budgetUsdCents }, storeId);
  return row;
}

const specOf = (r: RequestRow) =>
  r.spec as unknown as CustomSpec & { itemHi?: string; colorsHi?: string[]; materialsHi?: string[]; otherWishes?: string | null; otherWishesHi?: string | null };

/** Buyer picks one of the maker's sent options → agreement v(n+1) (re-checked against her rules NOW). */
export async function chooseOption(requestId: string, pick: { kind: "option" | "alternative"; index: number }) {
  const r = await loadRequest(requestId);
  if (r.status === "paid" || r.status === "declined") throw new AgreementError(`This request is ${r.status}.`);
  let option: Option | undefined;
  if (pick.kind === "option") option = ((r.options ?? []) as OptionVerdict[])[pick.index]?.option;
  else {
    const alt = (r.counter as Counter | null)?.result;
    const a = alt && !alt.acceptable ? alt.alternatives[pick.index] : undefined;
    if (a) option = { quantity: a.quantity, unitPriceUsdCents: a.unitPriceUsdCents, completionBy: null, colors: null, materials: null, note: null };
  }
  if (!option) throw new AgreementError("That option isn't available.", 400);
  return proposeFromOption(r, option, pick.kind);
}

async function proposeFromOption(r: RequestRow, option: Option, origin: string) {
  const { e, inrPerUsd } = await rulesNow(r.storeId, r.id);
  if (!e) throw new AgreementError("The maker hasn't set up custom orders yet.");
  const v = validateOption(option, specOf(r), e, { now: new Date(), inrPerUsd });
  if (v.status === "blocked") {
    const c = v.checks.find((c) => c.blocking)!;
    throw new AgreementError(c.code === "below_minimum" || c.code === "loss" ? "That price no longer works for the maker." : c.en);
  }
  const store = await loadStore(r.storeId);
  const terms = buildTerms(v, specOf(r), store, e);
  const a = await proposeAgreement(r.id, r.storeId, terms);
  await logEvent("agreement_proposed", { requestId: r.id, version: a.version, origin, quantity: terms.quantity }, r.storeId);
  return a;
}

/** Buyer counter-offer: answered by code from her rules, instantly, with alternatives if refused. */
export async function counterOffer(requestId: string, c: { quantity: number; totalBudgetUsdCents: number }) {
  const r = await loadRequest(requestId);
  if (r.status === "paid" || r.status === "declined") throw new AgreementError(`This request is ${r.status}.`);
  if (!Number.isInteger(c.quantity) || c.quantity < 1 || c.quantity > 200 || !(c.totalBudgetUsdCents > 0)) throw new AgreementError("Enter a quantity and a total budget.", 400);
  const { e, inrPerUsd } = await rulesNow(r.storeId, r.id);
  if (!e) throw new AgreementError("The maker hasn't set up custom orders yet.");
  const result = evaluateCounter(c, specOf(r), e, { now: new Date(), inrPerUsd });
  const d = await db();
  const counter: Counter = { ...c, result, at: new Date().toISOString() };
  await d.update(schema.customRequests).set({ counter, updatedAt: new Date() }).where(eq(schema.customRequests.id, r.id));
  await logEvent("custom_counter", { requestId: r.id, acceptable: result.acceptable, quantity: c.quantity }, r.storeId);
  if (result.acceptable) {
    // Within her rules: becomes a proposed agreement; she still approves it herself.
    const a = await proposeFromOption(r, result.verdict.option, "counter");
    return { result, agreementId: a.id };
  }
  return { result, agreementId: null };
}

export async function buyerApprove(requestId: string, agreementId: string, hash: string) {
  const r = await loadRequest(requestId);
  const a = await currentAgreement(requestId);
  if (!a || a.id !== agreementId) throw new AgreementError("These terms were replaced by a newer version. Please review the latest terms.");
  const updated = await approveAgreement(agreementId, "buyer", hash, { finalCheck: finalCheckFor(r) });
  await logEvent("agreement_approved", { requestId, party: "buyer", version: a.version, both: updated.status === "approved" }, a.storeId);
  return updated;
}

/** What the buyer (or their agent) may see: never her costs or earnings. */
export async function buyerView(requestId: string) {
  const r = await loadRequest(requestId);
  const a = await currentAgreement(r.id);
  const counter = r.counter as Counter | null;
  const spec = specOf(r);
  const buyerChecks = new Set(["after_deadline", "fewer_pieces", "changes_request"]);
  return {
    id: r.id,
    status: r.status,
    request: { text: r.buyerText, quantity: spec.quantity, item: spec.item, colors: spec.colors, materials: spec.materials, deadline: spec.deadline, budgetUsdCents: spec.budgetUsdCents },
    options: ((r.options ?? []) as OptionVerdict[]).map((v, i) => ({
      index: i,
      quantity: v.option.quantity,
      unitPriceUsdCents: v.option.unitPriceUsdCents,
      totalUsdCents: v.totalUsdCents,
      readyBy: v.completion,
      estimatedDelivery: v.delivery,
      colors: v.option.colors,
      materials: v.option.materials,
      note: v.option.note,
      notes: v.checks.filter((c) => buyerChecks.has(c.code)).map((c) => c.en),
    })),
    counter: counter
      ? {
          quantity: counter.quantity,
          totalBudgetUsdCents: counter.totalBudgetUsdCents,
          acceptable: counter.result.acceptable,
          reason: counter.result.acceptable ? null : counter.result.reasonEn,
          alternatives: counter.result.acceptable ? [] : counter.result.alternatives.map((x, i) => ({ index: i, quantity: x.quantity, totalUsdCents: x.unitPriceUsdCents * x.quantity, text: x.en })),
        }
      : null,
    agreement: a ? agreementView(a, a.orderId ? await orderTracking(a.orderId) : null) : null,
  };
}

async function orderTracking(orderId: string) {
  const d = await db();
  const [o] = await d.select({ trackingNumber: schema.orders.trackingNumber, trackingCarrier: schema.orders.trackingCarrier }).from(schema.orders).where(eq(schema.orders.id, orderId));
  return o ?? null;
}

function agreementView(a: AgreementRow, order?: { trackingNumber: string | null; trackingCarrier: string | null } | null) {
  const t = a.terms as Terms;
  return {
    progress: a.status === "paid" ? { done: a.piecesDone, total: t.quantity, readyBy: t.completionBy } : null,
    tracking: order?.trackingNumber ? { number: order.trackingNumber, carrier: order.trackingCarrier } : null,
    id: a.id,
    version: a.version,
    status: a.status,
    termsHash: a.termsHash,
    lines: termsLinesEn(t),
    totalUsdCents: t.totalUsdCents,
    buyerApproved: a.buyerApprovedHash === a.termsHash,
    sellerApproved: a.sellerApprovedHash === a.termsHash,
    holdUntil: a.holdUntil?.toISOString() ?? null,
    payable: payableProblem(a) === null,
    blockedBecause: a.status === "paid" ? null : payableProblem(a),
    orderId: a.orderId,
  };
}

// ── Maker side ──────────────────────────────────────────────────────────────

/** Facts computed from her rules for this request — shown before she answers. */
export function adviceFor(spec: CustomSpec, e: Economics | null, now: Date, inrPerUsd: number): { hi: string[]; en: string[] } {
  const hi: string[] = [];
  const en: string[] = [];
  if (!e) return { hi: ["पहले अपने नियम (खर्च, कमाई, क्षमता) सेव करें।"], en: ["Save your rules (costs, minimum, capacity) first."] };
  if (e.piecesPerWeek) {
    // Planner answer, accepted only after the independent checker verifies it; otherwise today's formulas.
    const proof = capacityProof(e, spec.quantity, spec.deadline, now, inrPerUsd);
    const fallbackDone = completionDate(now, e.backlogPieces, spec.quantity, e.piecesPerWeek);
    const done = proof.verified && proof.earliest ? proof.earliest.readyBy : isoDate(fallbackDone);
    const arrive = proof.verified && proof.earliest ? proof.earliest.delivery : isoDate(deliveryEstimate(fallbackDone, e.shippingDays));
    hi.push(`अभी के काम के साथ, ${spec.quantity} पीस ${hiDate(done)} तक बनेंगे, पहुँचने का अनुमान ${hiDate(arrive)}।`);
    en.push(`With work already booked (${e.backlogPieces} pcs), ${spec.quantity} pieces can be ready ${done}; estimated delivery ${arrive}.`);
    if (spec.deadline) {
      const b = proof.verified ? proof.byDeadline : null;
      const max = b ? b.max : maxQuantityByDeadline(now, new Date(spec.deadline), e.backlogPieces, e.piecesPerWeek, e.shippingDays);
      if (b ? !b.fits : max < spec.quantity) {
        if (b && b.max === Math.max(0, b.capacity - b.booked)) {
          // The reason, in her terms: her pace up to the last working day, minus what is already promised.
          hi.push(`ख़रीदार की तारीख़ तक ज़्यादा से ज़्यादा ${max} पीस पहुँच सकते हैं — आज से ${hiDate(b.lastWorkDay)} तक आपकी रफ़्तार से ${b.capacity} पीस बनते हैं, और ${b.booked} पहले से वादा किए हुए हैं।`);
          en.push(`At most ${max} pieces can arrive by the buyer's date: at your pace you can make ${b.capacity} by ${b.lastWorkDay} (the last day before courier time), and ${b.booked} are already promised. Independently checked.`);
        } else {
          hi.push(`ख़रीदार की तारीख़ तक ज़्यादा से ज़्यादा ${max} पीस पहुँच सकते हैं।`);
          en.push(`At most ${max} pieces can arrive by the buyer's date.`);
        }
      }
    }
  }
  const min = minimumUnitPriceUsdCents(e, spec.quantity, inrPerUsd);
  if (min !== null) {
    hi.push(`आपकी न्यूनतम कमाई के लिए ${spec.quantity} पीस पर हर पीस कम से कम ${(min / 100).toFixed(2)} डॉलर चाहिए।`);
    en.push(`To leave your minimum, ${spec.quantity} pieces need at least ${usd(min)} each (${usd(min * spec.quantity + e.shippingChargeUsdCents)} incl. shipping).`);
    if (spec.budgetUsdCents && spec.budgetUsdCents < min * spec.quantity + e.shippingChargeUsdCents) {
      hi.push("ख़रीदार का बजट इससे कम है।");
      en.push("The buyer's budget is below that.");
    }
  }
  return { hi, en };
}

export function optionsReadbackHi(verdicts: OptionVerdict[]): string {
  if (!verdicts.length) return "कोई दाम या संख्या समझ नहीं आई। फिर से बोलिए — जैसे “सात पीस, पैंतीस डॉलर हर पीस”।";
  return verdicts
    .map((v, i) => {
      const head = `${ORDINAL_HI[i] ?? `${i + 1}वाँ`} विकल्प: ${v.option.quantity} पीस, हर पीस ${(v.option.unitPriceUsdCents / 100).toFixed(2)} डॉलर, ${hiDate(v.completion)} तक तैयार।`;
      if (v.status === "blocked") return `${head} यह नहीं भेजा जा सकता: ${v.checks.filter((c) => c.blocking).map((c) => c.hi).join(" ")}`;
      const earn = v.checks.find((c) => c.code === "earnings_ok");
      return `${head} ${earn?.hi ?? ""}`.trim();
    })
    .join(" ");
}

/** Her spoken answer → options, each checked by code. Saved as a DRAFT; nothing reaches the buyer yet. */
export async function draftAnswer(
  requestId: string,
  input: { text?: string; audio?: { data: Uint8Array; mediaType: string } },
  deps: { hear?: typeof hearSellerAnswer } = {},
) {
  const r = await loadRequest(requestId);
  const { e, inrPerUsd } = await rulesNow(r.storeId, r.id);
  const now = new Date();
  const heard = await (deps.hear ?? hearSellerAnswer)(input, specOf(r), now);
  if (heard.decline) return { heard: heard.transcript, decline: true, verdicts: [], readback: "आप यह ऑर्डर नहीं लेना चाहतीं — “मना करें” दबाकर ख़रीदार को बता दें।" };
  if (!e) throw new AgreementError("Save your rules first.");
  const verdicts = optionsFrom(heard, inrPerUsd).map((o) => validateOption(o, specOf(r), e, { now, inrPerUsd }));
  const d = await db();
  await d.update(schema.customRequests).set({ sellerSaid: heard.transcript, draftOptions: verdicts, updatedAt: now }).where(eq(schema.customRequests.id, r.id));
  await logEvent("custom_options_drafted", { requestId: r.id, options: verdicts.length, blocked: verdicts.filter((v) => v.status === "blocked").length }, r.storeId);
  return { heard: heard.transcript, decline: false, verdicts, readback: optionsReadbackHi(verdicts) };
}

/** She sends the options she approves. Blocked options can never be sent. */
export async function sendOptions(requestId: string, indexes: number[]) {
  const r = await loadRequest(requestId);
  if (r.status === "paid" || r.status === "declined") throw new AgreementError(`This request is ${r.status}.`);
  const draft = (r.draftOptions ?? []) as OptionVerdict[];
  const chosen = [...new Set(indexes)].map((i) => draft[i]).filter((v): v is OptionVerdict => !!v);
  if (!chosen.length) throw new AgreementError("Choose at least one option.", 400);
  if (chosen.some((v) => v.status !== "valid")) throw new AgreementError("A blocked option can't be sent.");
  const d = await db();
  await d
    .update(schema.customRequests)
    .set({ options: chosen, status: r.status === "new" ? "options_sent" : r.status, updatedAt: new Date() })
    .where(eq(schema.customRequests.id, r.id));
  await logEvent("custom_options_sent", { requestId: r.id, options: chosen.length }, r.storeId);
}

/**
 * She approves the exact terms. Checked now (immediate feedback) and again,
 * atomically, at the moment the terms become fully approved.
 */
export async function sellerApprove(requestId: string, agreementId: string, hash: string) {
  const r = await loadRequest(requestId);
  const a = await currentAgreement(requestId);
  if (!a || a.id !== agreementId) throw new AgreementError("These terms were replaced by a newer version.");
  const problem = await termsProblem(r, a.terms as Terms);
  if (problem) throw new AgreementError(`${problem} Send revised terms instead.`);
  const updated = await approveAgreement(agreementId, "seller", hash, { finalCheck: finalCheckFor(r) });
  await logEvent("agreement_approved", { requestId: r.id, party: "seller", version: a.version, both: updated.status === "approved" }, r.storeId);
  return updated;
}

/**
 * After payment she records finished pieces. Booked capacity shrinks as she goes;
 * when the last piece is done the buyer is told and the order moves to "ready to ship".
 */
export async function recordProgress(requestId: string, piecesDone: number) {
  const r = await loadRequest(requestId);
  const d = await db();
  const [a] = await d.select().from(schema.agreements).where(and(eq(schema.agreements.requestId, r.id), eq(schema.agreements.status, "paid")));
  if (!a) throw new AgreementError("Progress can be recorded once the order is paid.");
  const total = (a.terms as Terms).quantity;
  const done = Math.min(total, Math.max(0, Math.round(Number(piecesDone) || 0)));
  await d.update(schema.agreements).set({ piecesDone: done }).where(eq(schema.agreements.id, a.id));
  if (done === total && a.piecesDone < total && a.orderId) {
    await d.insert(schema.messages).values({
      storeId: r.storeId,
      orderId: a.orderId,
      direction: "seller_to_buyer",
      channel: "autopilot",
      originalText: `आपके सभी ${total} पीस बन गए हैं। जल्द ही भेज दूँगी और ट्रैकिंग नंबर बताऊँगी।`,
      originalLanguage: "Hindi",
      translatedText: `All ${total} of your pieces are finished. I'll ship them soon and send you the tracking number.`,
      translatedLanguage: "English",
    });
  }
  await logEvent("custom_progress", { requestId: r.id, done, total }, r.storeId);
  return { done, total };
}

export async function declineRequest(requestId: string, hooks: import("./agreement").Hooks = {}) {
  const r = await loadRequest(requestId);
  await withTx(async (tx) => {
    // Lock order shared with revision and capture: request, then its agreements — then read.
    await tx.execute(sql`select id from custom_requests where id = ${r.id} for update`);
    await tx.execute(sql`select id from agreements where request_id = ${r.id} for update`);
    const versions = await tx.select({ status: schema.agreements.status }).from(schema.agreements).where(eq(schema.agreements.requestId, r.id));
    await hooks.afterRead?.();
    if (versions.some((v) => v.status === "paying")) throw new AgreementError("A payment is being processed — wait for it to finish.");
    if (versions.some((v) => v.status === "paid")) throw new AgreementError("Already paid.");
    await tx.update(schema.customRequests).set({ status: "declined", updatedAt: new Date() }).where(eq(schema.customRequests.id, r.id));
    await tx
      .update(schema.agreements)
      .set({ status: "cancelled" })
      .where(and(eq(schema.agreements.requestId, r.id), ne(schema.agreements.status, "superseded")));
  });
  await logEvent("custom_declined", { requestId: r.id }, r.storeId);
}

export async function sellerView(requestId: string) {
  const r = await loadRequest(requestId);
  const { e, inrPerUsd } = await rulesNow(r.storeId, r.id);
  const a = await currentAgreement(r.id);
  const spec = specOf(r);
  return {
    ...(await buyerView(requestId)),
    buyerName: r.buyerName,
    channel: r.channel,
    summaryHi: r.summaryHi,
    otherWishes: spec.otherWishes ?? null,
    advice: adviceFor(spec, e, new Date(), inrPerUsd),
    sellerSaid: r.sellerSaid,
    draft: ((r.draftOptions ?? []) as OptionVerdict[]).map((v, i) => ({ index: i, ...v })),
    agreementHi: a ? termsHi(a.terms as Terms, inrPerUsd) : null,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function listRequests(storeId: string) {
  const d = await db();
  const rows = await d.select().from(schema.customRequests).where(eq(schema.customRequests.storeId, storeId)).orderBy(desc(schema.customRequests.createdAt));
  return rows.map((r) => ({ id: r.id, status: r.status, summaryHi: r.summaryHi, buyerName: r.buyerName, channel: r.channel, createdAt: r.createdAt.toISOString() }));
}

/** For agents (MCP): what she can make and when — never her costs or minimum. */
export async function makerCapabilities(storeId: string, quantity?: number, deadline?: string) {
  if (deadline !== undefined && !isCalendarDate(deadline)) throw new AgreementError("Use a real calendar date in YYYY-MM-DD format.", 400);
  const { e } = await rulesNow(storeId);
  if (!e || !e.piecesPerWeek) return { acceptsCustomOrders: false as const };
  const now = new Date();
  const q = quantity && quantity > 0 ? Math.min(200, Math.round(quantity)) : null;
  // Planner + independent checker; today's formulas only if the check doesn't pass.
  const proof = q || deadline ? capacityProof(e, q ?? 1, deadline ?? null, now, env().INR_PER_USD) : null;
  const done = q ? completionDate(now, e.backlogPieces, q, e.piecesPerWeek) : null;
  const earliest = proof?.verified && proof.earliest ? proof.earliest : done ? { readyBy: isoDate(done), delivery: isoDate(deliveryEstimate(done, e.shippingDays)) } : null;
  const maxBy = (d: string) => {
    if (proof?.verified && proof.byDeadline) return proof.byDeadline.max;
    return maxQuantityByDeadline(now, new Date(d), e.backlogPieces, e.piecesPerWeek!, e.shippingDays);
  };
  const earliestChecked = !!(q && proof?.verified && proof.earliest);
  const maximumChecked = !!(deadline && proof?.verified && proof.byDeadline);
  return {
    acceptsCustomOrders: true as const,
    piecesPerWeek: e.piecesPerWeek,
    piecesAlreadyBooked: e.backlogPieces,
    typicalCourierDays: e.shippingDays,
    shippingUsd: (e.shippingChargeUsdCents / 100).toFixed(2),
    ...(q && earliest ? { forQuantity: q, earliestReadyBy: earliest.readyBy, estimatedDelivery: earliest.delivery } : {}),
    ...(deadline ? { maxPiecesDeliveredBy: { date: deadline, pieces: maxBy(deadline) } } : {}),
    earliestChecked,
    maximumChecked,
    capacityChecked: !!(q || deadline) && (!q || earliestChecked) && (!deadline || maximumChecked),
    pricing: "Quoted by the maker for each request; her answer is checked against her own costs before you see it.",
    howToOrder: "Call request_custom_order with a plain-language description; the buyer approves final terms and pays via PayPal on the link returned.",
  };
}
