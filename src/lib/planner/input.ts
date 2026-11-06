import { z } from "zod";
import type { Issue } from "./model";

/** Solver boundary only. The checker validates inputs independently in check-input.ts. */
export function inputIssues(facts: unknown, request: unknown, now: Date): Issue[] {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return [{ code: "inconsistent", fact: "now", en: "A valid planning time is required.", hi: "योजना का सही समय चाहिए।" }];
  }
  const count = z.number().finite().int().min(0).max(1_000_000);
  const duration = z.number().finite().int().min(0).max(366);
  const amount = z.number().finite().min(0).max(1_000_000).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.000001, "Use at most two decimal places");
  const id = z.string().min(1).max(200);
  const prov = z.object({
    source: z.enum(["maker_confirmed", "coordinator_entered", "buyer_stated", "system"]),
    by: z.string().max(200).optional(),
    at: z.string().max(60).datetime({ offset: true }).refine((s) => Date.parse(s) <= now.getTime(), "Confirmation cannot be in the future"),
  });
  const sourced = <T extends z.ZodTypeAny>(value: T) => z.object({ value, prov });
  const production = z.object({ makerId: id, day: duration, pieces: count.positive() });
  const finishing = z.object({ day: duration, pieces: count.positive() });
  const schema = z.object({
    facts: z.object({
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
        const t = Date.parse(s + "T00:00:00Z");
        return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
      }, "Invalid start date"),
      horizonDays: duration.positive(),
      finishingPerDay: sourced(z.array(count.max(10_000)).max(366)),
      lagDays: duration,
      packDays: duration,
      transitDays: sourced(duration),
      costs: z.object({ finishingInrPerPiece: amount, packagingInrPerPiece: amount, collectionInrPerPiece: amount, chargeInrPerPiece: amount, shippingInrPerOrder: amount }),
      fee: z.object({ percent: z.number().finite().min(0).max(20), fixedUsdCents: count }),
      inrPerUsd: sourced(z.number().finite().min(0.01).max(10_000)),
      staleAfterDays: duration,
      makers: z.array(z.object({
        id, name: z.string().min(1).max(200), capable: sourced(z.boolean()),
        dailyCapacity: sourced(z.array(count.max(10_000)).max(366)),
        materialsReadyDay: sourced(count.max(3650)).nullable(),
        commitments: sourced(z.array(z.object({ ref: id, pieces: count.positive(), dueDay: count.max(3650).nullable() })).max(1000)),
        askInrPerPiece: sourced(amount), floorInrPerPiece: sourced(amount),
        maxPieces: sourced(count).nullable(), fixedCostInr: amount,
      })).max(50),
      reservations: z.array(z.object({ planId: id, production: z.array(production).max(20_000), finishing: z.array(finishing).max(366) })).max(1000),
    }),
    request: z.object({ quantity: count.positive(), deliveryDay: count.max(3650), budgetUsdCents: z.number().finite().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable() }),
  }).superRefine(({ facts: f }, ctx) => {
    const fail = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["facts", ...path], message });
    if (new Set(f.makers.map((m) => m.id)).size !== f.makers.length) fail(["makers"], "Maker IDs must be unique");
    if (new Set(f.reservations.map((r) => r.planId)).size !== f.reservations.length) fail(["reservations"], "Reservation IDs must be unique");
    if (f.finishingPerDay.value.length !== f.horizonDays) fail(["finishingPerDay"], "A finishing capacity is required for every day");
    const ids = new Set(f.makers.map((m) => m.id));
    let entries = 0;
    f.reservations.forEach((r, i) => {
      entries += r.production.length + r.finishing.length;
      r.production.forEach((p, j) => {
        if (!ids.has(p.makerId) || p.day >= f.horizonDays) fail(["reservations", i, "production", j], "Reservation refers to an unknown maker or day");
      });
      r.finishing.forEach((p, j) => { if (p.day >= f.horizonDays) fail(["reservations", i, "finishing", j], "Reservation day is outside the horizon"); });
    });
    if (entries > 20_000) fail(["reservations"], "At most 20,000 reservation entries are supported");
  });
  const parsed = schema.safeParse({ facts, request });
  return parsed.success ? [] : parsed.error.issues.map((e) => ({
    code: "inconsistent", fact: e.path.join("."), en: `${e.path.join(".")}: ${e.message}`, hi: `${e.path.join(".")}: जानकारी सही और तय सीमा में होनी चाहिए।`,
  }));
}
