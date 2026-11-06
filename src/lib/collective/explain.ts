import { dayDate, type CollectiveFacts, type CutCert, type Evaluation, type Issue } from "@/lib/planner/model";

/**
 * Plain words for a planner answer. Every number is read from the evaluation or
 * recomputed from the facts; nothing is generated. `audience: "buyer"` keeps only
 * aggregates (no maker names, asks, availability or promises).
 */

export type Words = { en: string; hi: string };

const enDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const hiDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("hi-IN", { day: "numeric", month: "long", timeZone: "UTC" });
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

/** Finishing capacity left on each day after other reservations. */
function finishingLeft(facts: CollectiveFacts): number[] {
  const fin = [...facts.finishingPerDay.value];
  for (const r of facts.reservations) for (const f of r.finishing) if (f.day >= 0 && f.day < fin.length) fin[f.day] -= f.pieces;
  return fin;
}

/** A capacity cut in words: before τ the makers can have at most X ready; from τ finishing handles at most Y. */
export function cutWords(facts: CollectiveFacts, cut: CutCert, requested: number): Words {
  const fin = finishingLeft(facts);
  const last = Math.min(cut.lastFinishDay, facts.horizonDays - 1);
  let Y = 0;
  for (let t = cut.tau; t <= last; t++) Y += fin[t] ?? 0;
  const X = cut.bound - Y;
  const lastDate = dayDate(facts.startDate, cut.lastFinishDay);
  if (cut.tau > last) {
    return {
      en: `By ${enDay(lastDate)}, the last finishing day before dispatch, the makers can have at most ${X} pieces ready, fewer than the ${requested} asked for.`,
      hi: `${hiDay(lastDate)} तक (भेजने से पहले फ़िनिशिंग का आख़िरी दिन) सब मिलकर ज़्यादा से ज़्यादा ${X} पीस तैयार कर सकती हैं — ${requested} से कम।`,
    };
  }
  const tauDate = dayDate(facts.startDate, cut.tau);
  if (X === 0) {
    return {
      en: `From ${enDay(tauDate)} to ${enDay(lastDate)}, finishing can handle at most ${Y} pieces, fewer than the ${requested} asked for, whatever the makers do.`,
      hi: `${hiDay(tauDate)} से ${hiDay(lastDate)} तक फ़िनिशिंग में ज़्यादा से ज़्यादा ${Y} पीस हो सकते हैं — ${requested} से कम, चाहे सब कितना भी बनाएँ।`,
    };
  }
  return {
    en: `Before ${enDay(tauDate)} the makers can have at most ${X} pieces ready for finishing, and from ${enDay(tauDate)} to ${enDay(lastDate)} finishing can handle at most ${Y} more: ${X + Y} in all, fewer than the ${requested} asked for.`,
    hi: `${hiDay(tauDate)} से पहले सब मिलकर ज़्यादा से ज़्यादा ${X} पीस फ़िनिशिंग के लिए दे सकती हैं, और ${hiDay(tauDate)} से ${hiDay(lastDate)} तक फ़िनिशिंग में ज़्यादा से ज़्यादा ${Y} और: कुल ${X + Y}, जो ${requested} से कम है।`,
  };
}

const issueWords = (issues: Issue[]): Words[] => issues.filter((i) => i.code !== "excluded").map((i) => ({ en: i.en, hi: i.hi }));

export type Summary = { headline: Words; reasons: Words[]; alternatives: (Words & { choice: string })[]; notes: Words[] };

export function summarise(ev: Evaluation, facts: CollectiveFacts, requested: { quantity: number; deadline: string; budgetUsdCents: number | null }, audience: "internal" | "buyer"): Summary {
  const notes = audience === "internal" && "notes" in ev ? issueWords(ev.notes) : [];
  const due = enDay(requested.deadline);
  const dueHi = hiDay(requested.deadline);
  if (ev.kind === "unresolved") {
    return {
      headline: { en: "Not decided yet: some facts are missing or need confirming.", hi: "अभी तय नहीं: कुछ जानकारी बाकी है या पक्की करनी है।" },
      reasons: audience === "internal" ? issueWords(ev.issues) : [{ en: "The collective is confirming its makers' availability.", hi: "संगठन अपने कारीगरों से समय पक्का कर रहा है।" }],
      alternatives: [],
      notes: [],
    };
  }
  if (ev.kind === "feasible") {
    const p = ev.plan;
    const makers = new Set(p.production.map((x) => x.makerId)).size;
    return {
      headline: {
        en: `Yes: ${p.quantity} pieces can be delivered by ${due}, made by ${makers} makers, for ${usd(p.money.priceUsdCents)} in all.`,
        hi: `हाँ: ${p.quantity} पीस ${dueHi} तक पहुँच सकते हैं, ${makers} कारीगर मिलकर बनाएँगी, कुल ${usd(p.money.priceUsdCents)}।`,
      },
      reasons:
        audience === "internal"
          ? [
              ev.certified
                ? { en: "Cheapest plan: certified (no feasible plan costs less).", hi: "सबसे सस्ती योजना — पक्का (इससे कम में कोई योजना संभव नहीं)।" }
                : { en: "Cheapest not certified: a maker with incomplete facts might allow a cheaper plan.", hi: "सबसे सस्ती होने की पुष्टि नहीं — किसी की अधूरी जानकारी से सस्ती योजना हो सकती है।" },
            ]
          : [],
      alternatives: [{ choice: "primary", en: `Offer ${p.quantity} by ${due}`, hi: `${p.quantity} पीस ${dueHi} तक` }],
      notes,
    };
  }
  if (ev.kind === "infeasible_budget") {
    const lw = ev.alternatives.largestWithinBudget;
    const alts: Summary["alternatives"] = [{ choice: "lowest_price", en: `Offer all ${ev.plan.quantity} at the lowest covering price, ${usd(ev.plan.money.priceUsdCents)}`, hi: `सभी ${ev.plan.quantity} पीस सबसे कम दाम ${usd(ev.plan.money.priceUsdCents)} में` }];
    if (lw && lw.quantity > 0 && "plan" in lw) alts.push({ choice: "within_budget", en: `Offer ${lw.quantity} pieces within the budget (${usd(lw.plan.money.priceUsdCents)})`, hi: `बजट में ${lw.quantity} पीस (${usd(lw.plan.money.priceUsdCents)})` });
    return {
      headline: {
        en: `Not within the budget: the lowest price that covers every maker's asking price and the collective's costs is ${usd(ev.plan.money.priceUsdCents)}, above ${usd(ev.budgetUsdCents)}.`,
        hi: `बजट में नहीं: सबका माँगा दाम और संगठन का ख़र्च मिलाकर सबसे कम दाम ${usd(ev.plan.money.priceUsdCents)} है, जो ${usd(ev.budgetUsdCents)} से ज़्यादा है।`,
      },
      reasons: [
        { en: "This minimum is certified: no feasible plan costs less.", hi: "यह न्यूनतम पक्का है: इससे कम में कोई योजना संभव नहीं।" },
        lw && lw.quantity > 0
          ? { en: `Within the budget: at most ${lw.quantity} pieces by ${due}.`, hi: `बजट में ${dueHi} तक ज़्यादा से ज़्यादा ${lw.quantity} पीस।` }
          : { en: "Within the budget: not even one piece.", hi: "बजट में एक पीस भी नहीं।" },
      ],
      alternatives: alts,
      notes,
    };
  }
  // infeasible_capacity
  const alts: Summary["alternatives"] = [];
  const reasons: Words[] = [cutWords(facts, ev.cut, ev.requested)];
  const lb = ev.alternatives.largestByDate;
  if (lb && lb.quantity > 0) alts.push({ choice: "largest_by_date", en: `Offer ${lb.quantity} pieces by ${due} (the most possible)`, hi: `${dueHi} तक ${lb.quantity} पीस (जितने हो सकते हैं)` });
  const ed = ev.alternatives.earliestDelivery;
  if (ed?.kind === "found") {
    const d = dayDate(facts.startDate, ed.plan.deliveryDay);
    alts.push({ choice: "earliest", en: `Offer all ${ev.requested} by ${enDay(d)} (the earliest possible)`, hi: `सभी ${ev.requested} पीस ${hiDay(d)} तक (सबसे जल्दी)` });
  } else if (ed?.kind === "not_within_horizon") {
    reasons.push({ en: `All ${ev.requested} pieces: not within the next ${ed.horizonDays} days on the makers' current availability.`, hi: `सभी ${ev.requested} पीस: अभी के समय के हिसाब से अगले ${ed.horizonDays} दिनों में नहीं।` });
  }
  return {
    headline: {
      en: `No: at most ${ev.maxQuantity} of the ${ev.requested} pieces can be delivered by ${due}.`,
      hi: `नहीं: ${dueHi} तक ${ev.requested} में से ज़्यादा से ज़्यादा ${ev.maxQuantity} पीस पहुँच सकते हैं।`,
    },
    reasons,
    alternatives: alts,
    notes,
  };
}
