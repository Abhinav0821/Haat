import type { CollectiveFacts, Commitment, MakerFacts, Reservation, Source, Sourced } from "@/lib/planner/model";

export const NOW = new Date("2026-11-06T09:00:00Z");
export const CONFIRMED_AT = "2026-11-05T12:00:00Z";

export const src = <T>(value: T, source: Source = "maker_confirmed", at = CONFIRMED_AT): Sourced<T> => ({ value, prov: { source, at } });

export function maker(
  id: string,
  o: {
    cap: number[];
    ready?: number | null;
    ask?: number;
    floor?: number;
    commits?: Commitment[];
    max?: number | null;
    capable?: boolean;
    fixed?: number;
    confirmedAt?: string;
  },
): MakerFacts {
  const at = o.confirmedAt ?? CONFIRMED_AT;
  return {
    id,
    name: id,
    capable: src(o.capable ?? true, "maker_confirmed", at),
    dailyCapacity: src(o.cap, "maker_confirmed", at),
    materialsReadyDay: o.ready === null ? null : src(o.ready ?? 0, "maker_confirmed", at),
    commitments: src(o.commits ?? [], "maker_confirmed", at),
    askInrPerPiece: src(o.ask ?? 900),
    floorInrPerPiece: src(o.floor ?? 700),
    maxPieces: o.max === null || o.max === undefined ? null : src(o.max),
    fixedCostInr: o.fixed ?? 0,
  };
}

export function collective(o: {
  H: number;
  fin: number[];
  makers: MakerFacts[];
  lag?: number;
  pack?: number;
  transit?: number;
  reservations?: Reservation[];
  costs?: Partial<CollectiveFacts["costs"]>;
}): CollectiveFacts {
  return {
    startDate: "2026-11-06",
    horizonDays: o.H,
    finishingPerDay: src(o.fin, "coordinator_entered"),
    lagDays: o.lag ?? 1,
    packDays: o.pack ?? 0,
    transitDays: src(o.transit ?? 0, "coordinator_entered"),
    costs: {
      finishingInrPerPiece: 60,
      packagingInrPerPiece: 40,
      collectionInrPerPiece: 20,
      chargeInrPerPiece: 50,
      shippingInrPerOrder: 4000,
      ...o.costs,
    },
    fee: { percent: 5.4, fixedUsdCents: 30 },
    inrPerUsd: src(88, "system"),
    reservations: o.reservations ?? [],
    staleAfterDays: 14,
    makers: o.makers,
  };
}

export const daily = (perDay: number, H: number, off: number[] = []) => Array.from({ length: H }, (_, t) => (off.includes(t) ? 0 : perDay));

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
