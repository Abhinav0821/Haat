import { z } from "zod";
import { isCalendarDate } from "@/lib/calendar-date";
import { dayDate, dayIndex } from "@/lib/planner/model";
import { parseSnapshot, type PlanningSnapshot } from "@/lib/planner/snapshot";
import { asPlan, type Answer } from "./approaches";
import { completeAnswerCorrect, score } from "./score";
import { truthOf } from "./scenarios";

const date = z.string().refine(isCalendarDate, "Use a real YYYY-MM-DD date");
const entry = z.object({ date, pieces: z.number().int().positive() });
const quote = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const common = { scenarioFingerprint: z.string().length(64) };
export const ManualAnswer = z.discriminatedUnion("decision", [
  z.object({ ...common, decision: z.literal("yes"), priceUsdCents: quote, production: z.array(entry.extend({ maker: z.string().min(1) })).max(20_000), finishing: z.array(entry).max(366) }),
  z.object({ ...common, decision: z.literal("no_capacity"), maxQuantityByDate: z.number().int().nonnegative() }),
  z.object({ ...common, decision: z.literal("no_budget"), priceUsdCents: quote }),
  z.object({ ...common, decision: z.literal("cannot_decide"), reason: z.string().min(1) }),
]);

export function assessManual(snapshot: PlanningSnapshot, value: unknown) {
  const s = parseSnapshot(snapshot), a = ManualAnswer.parse(value);
  if (a.scenarioFingerprint !== s.fingerprint) throw new Error("This answer belongs to a different scenario. Use the same snapshot for both rounds.");
  let answer: Answer;
  switch (a.decision) {
    case "yes": {
      const production = a.production.map((p) => {
        const makers = s.facts.makers.filter((m) => m.id === p.maker || m.name === p.maker);
        if (makers.length !== 1) throw new Error(`Unknown or ambiguous maker ${p.maker}; use her exact id from the snapshot.`);
        return { makerId: makers[0].id, day: dayIndex(s.facts.startDate, p.date), pieces: p.pieces };
      });
      answer = { kind: "yes", plan: asPlan(s.facts, s.request, production, a.finishing.map((f) => ({ day: dayIndex(s.facts.startDate, f.date), pieces: f.pieces }))), statedPriceUsdCents: a.priceUsdCents };
      break;
    }
    case "no_capacity": answer = { kind: "no_capacity", maxQuantity: a.maxQuantityByDate }; break;
    case "no_budget": answer = { kind: "no_budget", priceUsdCents: a.priceUsdCents }; break;
    default: answer = { kind: "undecided", reason: a.reason };
  }
  const { ev, truth } = truthOf(s.facts, s.request, new Date(s.at));
  const scored = score({ id: s.fingerprint, label: "role-play", facts: s.facts, request: s.request, truth }, ev, answer, { now: new Date(s.at) });
  return { scenarioFingerprint: s.fingerprint, offeredPlanMatchedAtExport: s.source?.offeredFactsHash ? s.source.offeredFactsHash === s.factsFingerprint : null,
    valid: completeAnswerCorrect(scored), score: scored, truth, haat: ev,
    quotedPriceUsdCents: "priceUsdCents" in a ? a.priceUsdCents : null,
    schedulePriceUsdCents: answer.kind === "yes" ? answer.plan.money.priceUsdCents : null };
}

/** Both rounds must use the same facts, and the live Haat answer must have been evaluated on them. */
export function compareHaatInputs(before: PlanningSnapshot, after: PlanningSnapshot): boolean {
  parseSnapshot(before); parseSnapshot(after);
  return before.factsFingerprint === after.factsFingerprint && after.source?.evaluatedFactsHash === before.factsFingerprint;
}

/** A factual sheet only, with no planner result, for the manual-first round. */
export function scenarioSheet(s: PlanningSnapshot): string {
  parseSnapshot(s);
  return [
    `Scenario: ${s.fingerprint}`, `Inputs at: ${s.at}`, `Day 0: ${s.facts.startDate}`,
    `Request: ${s.request.quantity} pieces, delivery ${dayDate(s.facts.startDate, s.request.deliveryDay)}, budget cents ${s.request.budgetUsdCents ?? "none"}`,
    `Rest ${s.facts.lagDays} days; packing ${s.facts.packDays}; transit ${s.facts.transitDays.value}.`,
    `Costs INR: ${JSON.stringify(s.facts.costs)}; fee ${s.facts.fee.percent}% + ${s.facts.fee.fixedUsdCents} cents; INR/USD ${s.facts.inrPerUsd.value}.`,
    "Pricing rule: feeCents = round(P * feePercent / 100) + fixedFeeCents. Choose the lowest integer USD cents P such that round((P - feeCents) / 100 * INRperUSD) covers total INR cost. Aim for the cheapest valid allocation. Round halves up.",
    ...s.facts.makers.map((m) => `${m.name} [${m.id}]: capable ${m.capable.value}; materials ${m.materialsReadyDay ? dayDate(s.facts.startDate, m.materialsReadyDay.value) : "UNKNOWN"}; asks INR ${m.askInrPerPiece.value}; cap ${m.maxPieces?.value ?? "none"}; other promises ${JSON.stringify(m.commitments.value)}`),
    "Total capacities below: subtract reservations AND keep room for other promises.",
    ["day", "date", "finishing", ...s.facts.makers.map((m) => m.name)].join("\t"),
    ...Array.from({ length: s.facts.horizonDays }, (_, day) => [day, dayDate(s.facts.startDate, day), s.facts.finishingPerDay.value[day], ...s.facts.makers.map((m) => m.dailyCapacity.value[day])].join("\t")),
    `Reservations (day indices from day 0): ${JSON.stringify(s.facts.reservations)}`,
  ].join("\n");
}
