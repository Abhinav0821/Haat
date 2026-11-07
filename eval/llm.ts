import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText, Output } from "ai";
import { z } from "zod";
import type { CollectiveFacts, OrderRequest } from "@/lib/planner/model";
import { asPlan, type Answer } from "./approaches";
import { START } from "./scenarios";

/**
 * AI-direct baseline: one model is given the rules in plain words and the same facts
 * as JSON, and asked for the whole answer (decision, day-by-day schedule, price).
 * No tools, no solver. Its schedule is then judged by the independent checker; its
 * price is recomputed from its own schedule, and whether its stated price matched is
 * recorded separately.
 */

export const PROMPT_VERSION = "eval-llm-v1";

export const SYSTEM = `You plan orders for a collective of hand-block printers in India. Answer only from the facts given.

Rules (all must hold for a "yes"):
- Day 0 is Monday ${START}. Days are whole numbers. Every maker's capacity is given per day.
- A maker produces only on days >= her materialsReadyDay. If materialsReadyDay is null her materials date is unknown.
- On any day, a maker's pieces for this order plus pieces she still needs for her other promises can't exceed her capacity that day. Each other promise (pieces, dueDay) must still be completed by its dueDay using her remaining capacity (dueDay null: as early as her capacity allows, within the horizon).
- A maker never makes more than maxPieces for this order (null = no limit).
- Every piece is finished on the shared finishing table, which has its own capacity per day. A piece can be finished only at least lagDays after the day it was made.
- Packing takes packDays and transit takes transitDays, so the last finishing day is deliveryDay - transitDays - packDays - 1. All finishing must happen on or before that day, and within the horizon.
- The order needs exactly "quantity" pieces made and finished.
- Each maker is paid her askInrPerPiece for each piece she makes. Total cost (INR) = makers' pay + (finishing + packaging + collection + charge per piece) x quantity + shipping per order.
- Price (USD cents) P is the LOWEST whole number such that round((P - fee)/100 x inrPerUsd) >= total cost, where fee = round(P x feePercent / 100) + feeFixedUsdCents.
- Among valid schedules, choose the one with the lowest price.
- If the buyer has a budget and even the cheapest valid schedule costs more, the answer is "no_budget".
- If the quantity can't be made and finished by the date, the answer is "no_capacity"; give the largest quantity that could be.
- If the answer depends on facts that are unknown (e.g. a needed maker's materials date is null), the answer is "cannot_decide".

Return JSON only, matching the schema. For "yes", list every production entry and every finishing entry.`;

const Entry = z.object({ day: z.number().int(), pieces: z.number().int() });
export const LlmAnswer = z.object({
  decision: z.enum(["yes", "no_capacity", "no_budget", "cannot_decide"]),
  production: z.array(Entry.extend({ maker: z.string() })),
  finishing: z.array(Entry),
  priceUsdCents: z.number().int().nullable(),
  maxQuantityByDate: z.number().int().nullable(),
  reason: z.string(),
});
export type LlmRaw = z.infer<typeof LlmAnswer>;

export function factsForModel(f: CollectiveFacts, request: OrderRequest) {
  return {
    horizonDays: f.horizonDays,
    lagDays: f.lagDays,
    packDays: f.packDays,
    transitDays: f.transitDays.value,
    finishingPerDay: f.finishingPerDay.value,
    costsInr: {
      finishingPerPiece: f.costs.finishingInrPerPiece,
      packagingPerPiece: f.costs.packagingInrPerPiece,
      collectionPerPiece: f.costs.collectionInrPerPiece,
      chargePerPiece: f.costs.chargeInrPerPiece,
      shippingPerOrder: f.costs.shippingInrPerOrder,
    },
    feePercent: f.fee.percent,
    feeFixedUsdCents: f.fee.fixedUsdCents,
    inrPerUsd: f.inrPerUsd.value,
    makers: f.makers.map((m) => ({
      id: m.id,
      capacityPerDay: m.dailyCapacity.value,
      materialsReadyDay: m.materialsReadyDay?.value ?? null,
      otherPromises: m.commitments.value.map((c) => ({ pieces: c.pieces, dueDay: c.dueDay })),
      askInrPerPiece: m.askInrPerPiece.value,
      maxPieces: m.maxPieces?.value ?? null,
    })),
    request: { quantity: request.quantity, deliveryDay: request.deliveryDay, budgetUsdCents: request.budgetUsdCents },
  };
}

export function toAnswer(f: CollectiveFacts, request: OrderRequest, raw: LlmRaw): Answer {
  switch (raw.decision) {
    case "yes": {
      const production = raw.production.filter((p) => p.pieces !== 0).map((p) => ({ makerId: p.maker, day: p.day, pieces: p.pieces }));
      const finishing = raw.finishing.filter((x) => x.pieces !== 0).map((x) => ({ day: x.day, pieces: x.pieces }));
      return { kind: "yes", plan: asPlan(f, request, production, finishing), statedPriceUsdCents: raw.priceUsdCents };
    }
    case "no_capacity":
      return { kind: "no_capacity", maxQuantity: raw.maxQuantityByDate };
    case "no_budget":
      return { kind: "no_budget", priceUsdCents: raw.priceUsdCents };
    default:
      return { kind: "undecided", reason: raw.reason };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One call, one fixed model (no silent fallback to another model). Stops at once when the daily quota is gone. */
export async function askModel(modelId: string, apiKey: string, f: CollectiveFacts, request: OrderRequest): Promise<{ raw: LlmRaw | null; error: string | null; attempts: number; ms: number; quotaExhausted?: boolean }> {
  const model = createGoogleGenerativeAI({ apiKey })(modelId);
  const started = Date.now();
  let last = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { output } = await generateText({
        model,
        system: SYSTEM,
        prompt: `Facts and request:\n${JSON.stringify(factsForModel(f, request))}`,
        temperature: 0,
        maxRetries: 0,
        output: Output.object({ schema: LlmAnswer, name: "plan_answer" }),
        abortSignal: AbortSignal.timeout(300_000),
      });
      return { raw: output, error: null, attempts: attempt, ms: Date.now() - started };
    } catch (e) {
      last = (e as Error).message.slice(0, 300);
      // A spent daily quota won't come back by retrying; retries would only spend more.
      if (/exceeded your current quota|RESOURCE_EXHAUSTED|per day/i.test(last)) return { raw: null, error: last, attempts: attempt, ms: Date.now() - started, quotaExhausted: true };
      if (!/429|rate|503|overload|unavailable/i.test(last)) break; // timeouts and malformed output are recorded, not retried
      await sleep(30_000 * attempt);
    }
  }
  return { raw: null, error: last, attempts: 3, ms: Date.now() - started };
}
