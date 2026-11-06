import { z } from "zod";
import { isCalendarDate } from "@/lib/calendar-date";
import { dayDate, dayIndex, type CollectiveFacts, type MakerFacts, type Provenance, type Reservation } from "@/lib/planner/model";

/**
 * What a collective and its makers have told Haat, as stored — and the single
 * conversion into the planner's facts (model M1, docs/planner-model.md).
 *
 * Stored facts are calendar-based (weekday pattern, dates); the planner works in day
 * indices from a start date. Every planner fact keeps the provenance of the stored one.
 */

const isoDate = z.string().refine(isCalendarDate, "Use a real date (YYYY-MM-DD).");
const inr = z.number().finite().min(0).max(1_000_000)
  .refine((x) => Math.abs(Math.round(x * 100) - x * 100) < 0.000001, "At most two decimal places.")
  .transform((x) => Math.round(x * 100) / 100);
const count = z.number().int().min(0).max(10_000);
const ProvSchema = z.object({
  source: z.enum(["maker_confirmed", "coordinator_entered"]),
  by: z.string().max(80).optional(),
  at: z.string().datetime(),
});

export const SettingsSchema = z.object({
  product: z.object({ en: z.string().min(1).max(120), hi: z.string().min(1).max(120) }),
  /** Shared finishing/inspection pieces per weekday, Sunday first. */
  finishingPerWeekday: z.array(count).length(7),
  finishingOffDates: z.array(isoDate).max(366).default([]),
  lagDays: z.number().int().min(0).max(30),
  packDays: z.number().int().min(0).max(30),
  transitDays: z.number().int().min(0).max(60),
  costs: z.object({
    finishingInrPerPiece: inr,
    packagingInrPerPiece: inr,
    collectionInrPerPiece: inr,
    chargeInrPerPiece: inr,
    shippingInrPerOrder: inr,
  }),
  fee: z.object({ percent: z.number().min(0).max(20), fixedUsdCents: z.number().int().min(0).max(1_000_000) }),
  inrPerUsd: z.number().min(0.01).max(10_000),
  horizonDays: z.number().int().min(14).max(366).default(120),
  staleAfterDays: z.number().int().min(1).max(366).default(30),
  prov: ProvSchema,
});
export type CollectiveSettings = z.infer<typeof SettingsSchema>;

export const MemberFactsSchema = z
  .object({
    /** She makes the collective's product. */
    makesProduct: z.boolean(),
    /** Pieces she can make per weekday, Sunday first. */
    piecesPerWeekday: z.array(count).length(7),
    offDates: z.array(isoDate).max(366).default([]),
    /** Legacy delay from its statement date; new screens use materialsReadyDate. */
    materialsDays: z.number().int().min(0).max(120).nullable(),
    /** Absolute availability. Optional only for records written before this field existed. */
    materialsReadyDate: isoDate.nullable().optional(),
    /** Her other promises (outside this collective's orders). */
    commitments: z
      .array(z.object({ ref: z.string().min(1).max(60), pieces: z.number().int().min(1).max(100_000), due: isoDate.nullable() }))
      .max(50)
      .default([]),
    askInr: inr,
    /** Private minimum: never shown to buyers or other makers. */
    floorInr: inr,
    maxPieces: z.number().int().min(0).max(100_000).nullable(),
    prov: ProvSchema,
  })
  .refine((f) => f.floorInr <= f.askInr, { message: "Her asking price can't be below her own minimum.", path: ["askInr"] });
export type StoredMemberFacts = z.infer<typeof MemberFactsSchema>;

/** Legacy delays are anchored to their statement, never to a later plan or confirmation. */
export function materialsReadyOn(f: StoredMemberFacts): string | null {
  if (f.materialsReadyDate !== undefined) return f.materialsReadyDate;
  return f.materialsDays === null ? null : dayDate(f.prov.at.slice(0, 10), f.materialsDays);
}

/** Capacity held for another plan, in calendar dates. */
export type DatedReservation = {
  planId: string;
  production: { memberId: string; date: string; pieces: number }[];
  finishing: { date: string; pieces: number }[];
};

export type MemberRow = { id: string; name: string; facts: StoredMemberFacts };

const weekday = (startDate: string, t: number) => new Date(Date.parse(`${startDate}T00:00:00Z`) + t * 86_400_000).getUTCDay();

function pattern(startDate: string, H: number, perWeekday: number[], offDates: string[]): number[] {
  const off = new Set(offDates);
  return Array.from({ length: H }, (_, t) => (off.has(dayDate(startDate, t)) ? 0 : perWeekday[weekday(startDate, t)]));
}

/** Calendar reservations → planner reservations for this start date (past days dropped; later days beyond the horizon too). */
export function toDayReservations(startDate: string, H: number, rs: DatedReservation[]): Reservation[] {
  const inside = (d: string) => {
    const t = dayIndex(startDate, d);
    return t >= 0 && t < H ? t : null;
  };
  return rs.map((r) => ({
    planId: r.planId,
    production: r.production.flatMap((p) => {
      const day = inside(p.date);
      return day === null ? [] : [{ makerId: p.memberId, day, pieces: p.pieces }];
    }),
    finishing: r.finishing.flatMap((f) => {
      const day = inside(f.date);
      return day === null ? [] : [{ day, pieces: f.pieces }];
    }),
  }));
}

/**
 * The planner's facts for one order on `startDate`. `excluded` makers (declined and
 * explicitly left out by the coordinator) are kept visible as not capable, never dropped silently.
 */
export function buildFacts(
  settings: CollectiveSettings,
  members: MemberRow[],
  reservations: DatedReservation[],
  startDate: string,
  excluded: string[] = [],
): CollectiveFacts {
  const H = settings.horizonDays;
  const sp: Provenance = { ...settings.prov };
  const s = <T>(value: T, prov: Provenance = sp) => ({ value, prov });
  const makers: MakerFacts[] = members.map((m) => {
    const f = m.facts;
    const p: Provenance = { ...f.prov };
    const out = excluded.includes(m.id);
    const readyDate = materialsReadyOn(f);
    const commitments = f.commitments.map((c) => ({ ref: c.ref, pieces: c.pieces, dueDay: c.due === null ? null : dayIndex(startDate, c.due) }));
    return {
      id: m.id,
      name: m.name,
      capable: s(f.makesProduct && !out, out ? { source: "coordinator_entered", by: "left out after declining", at: p.at } : p),
      dailyCapacity: s(pattern(startDate, H, f.piecesPerWeekday, f.offDates), p),
      materialsReadyDay: readyDate === null ? null : s(Math.max(0, dayIndex(startDate, readyDate)), p),
      // A promise already past due is either done or late; it's kept as due today (the earliest she can still serve it).
      commitments: s(commitments.map((c) => (c.dueDay !== null && c.dueDay < 0 ? { ...c, dueDay: 0 } : c)), p),
      askInrPerPiece: s(f.askInr, p),
      floorInrPerPiece: s(f.floorInr, p),
      maxPieces: f.maxPieces === null ? null : s(f.maxPieces, p),
      fixedCostInr: 0,
    };
  });
  return {
    startDate,
    horizonDays: H,
    finishingPerDay: s(pattern(startDate, H, settings.finishingPerWeekday, settings.finishingOffDates)),
    lagDays: settings.lagDays,
    packDays: settings.packDays,
    transitDays: s(settings.transitDays),
    costs: { ...settings.costs },
    fee: { ...settings.fee },
    inrPerUsd: s(settings.inrPerUsd),
    reservations: toDayReservations(startDate, H, reservations),
    staleAfterDays: settings.staleAfterDays,
    makers,
  };
}
