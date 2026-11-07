import type { CollectiveFacts, MakerFacts, OrderRequest, Provenance } from "@/lib/planner/model";
import { evaluate } from "@/lib/planner/solve";
import { checkEvaluation } from "@/lib/planner/check";

/**
 * Evaluation scenarios: synthetic collectives and buyer requests, generated from a
 * recorded seed so every approach answers exactly the same cases.
 *
 * Shape (fixed for all scenarios, so the cases stay readable): six-week horizon,
 * 1 day between making and finishing, 1 day packing, 7 days transit, costs and
 * fees as in the demo collective. What varies: makers' weekday capacity, materials
 * dates, other promises, caps, asking prices, the shared finishing capacity, and
 * the request (quantity, date, sometimes a budget).
 *
 * The "truth" for each case is model M1's answer (docs/planner-model.md) after the
 * independent checker accepts it; the planner itself is validated against an
 * exhaustive reference on small instances (tests/planner-oracle.test.ts).
 */

export const H = 42;
export const START = "2026-11-09";
export const NOW = new Date("2026-11-08T09:00:00Z");
const AT = "2026-11-07T09:00:00Z";

export type Truth = "yes" | "no_capacity" | "no_budget" | "undecided";
export type Scenario = { id: string; label: string; facts: CollectiveFacts; request: OrderRequest; truth: Truth };

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

const prov = (source: Provenance["source"] = "maker_confirmed"): Provenance => ({ source, at: AT });
const s = <T>(value: T, source: Provenance["source"] = "maker_confirmed") => ({ value, prov: prov(source) });
// Day 0 is a Monday (2026-11-09): weekday of day t is (t + 1) % 7, Sunday = 0.
const fromWeek = (perWeekday: number[], off: number[] = []) => Array.from({ length: H }, (_, t) => (off.includes(t) ? 0 : perWeekday[(t + 1) % 7]));

export type MakerSpec = { id: string; week: number[]; ready: number | null; ask: number; max?: number | null; commits?: { pieces: number; dueDay: number | null }[]; off?: number[] };

export function makeFacts(makers: MakerSpec[], finishingWeek: number[]): CollectiveFacts {
  return {
    startDate: START,
    horizonDays: H,
    finishingPerDay: s(fromWeek(finishingWeek), "coordinator_entered"),
    lagDays: 1,
    packDays: 1,
    transitDays: s(7, "coordinator_entered"),
    costs: { finishingInrPerPiece: 40, packagingInrPerPiece: 30, collectionInrPerPiece: 15, chargeInrPerPiece: 45, shippingInrPerOrder: 4200 },
    fee: { percent: 4.4, fixedUsdCents: 30 },
    inrPerUsd: s(88, "system"),
    reservations: [],
    staleAfterDays: 30,
    makers: makers.map(
      (m): MakerFacts => ({
        id: m.id,
        name: m.id,
        capable: s(true),
        dailyCapacity: s(fromWeek(m.week, m.off)),
        materialsReadyDay: m.ready === null ? null : s(m.ready),
        commitments: s((m.commits ?? []).map((c, i) => ({ ref: `promise-${i + 1}`, pieces: c.pieces, dueDay: c.dueDay }))),
        askInrPerPiece: s(m.ask),
        floorInrPerPiece: s(m.ask - 40),
        maxPieces: m.max ? s(m.max) : null,
        fixedCostInr: 0,
      }),
    ),
  };
}

/** The checked M1 answer for a case; throws if the checker rejects it (then it can't be truth). */
export function truthOf(facts: CollectiveFacts, request: OrderRequest) {
  const ev = evaluate(facts, request, NOW);
  if (ev.kind !== "unresolved") {
    const problems = checkEvaluation(facts, request, ev, NOW);
    if (problems.length) throw new Error(`checker rejected the planner's answer: ${problems[0]}`);
  }
  const truth: Truth = ev.kind === "feasible" ? "yes" : ev.kind === "infeasible_capacity" ? "no_capacity" : ev.kind === "infeasible_budget" ? "no_budget" : "undecided";
  return { ev, truth };
}

const NAMES = ["Meera", "Sunita", "Rukhsana", "Lata", "Farida"];

function randomMakers(r: () => number, n: number, unknownMaterials: boolean): MakerSpec[] {
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const unknown = unknownMaterials ? int(0, n - 1) : -1;
  return Array.from({ length: n }, (_, i) => {
    const perDay = int(1, 4);
    const week = [0, ...Array.from({ length: 6 }, () => (r() < 0.2 ? 0 : Math.max(0, perDay + int(-1, 1))))];
    const commits = r() < 0.4 ? [{ pieces: int(3, 10), dueDay: r() < 0.7 ? int(4, 18) : null }] : [];
    return { id: NAMES[i], week, ready: i === unknown ? null : int(0, 6), ask: 350 + 10 * int(0, 13), max: r() < 0.25 ? int(10, 25) : null, commits };
  });
}

/** Hand-written cases for the failure modes a coordinator worries about (fixed, not random). */
export function handcrafted(): Scenario[] {
  const cases: { id: string; label: string; makers: MakerSpec[]; fin: number[]; req: OrderRequest }[] = [
    {
      id: "h1-finishing-bottleneck",
      label: "Makers could make plenty; the shared finishing table is the limit",
      makers: [
        { id: "Meera", week: [0, 6, 6, 6, 6, 6, 4], ready: 0, ask: 400 },
        { id: "Sunita", week: [0, 5, 5, 5, 5, 5, 0], ready: 0, ask: 380 },
      ],
      fin: [0, 3, 3, 3, 3, 3, 0],
      req: { quantity: 60, deliveryDay: 30, budgetUsdCents: null },
    },
    {
      id: "h2-cheap-maker-late",
      label: "The cheapest maker's materials arrive late; an earlier, dearer maker is needed for the date",
      makers: [
        { id: "Meera", week: [0, 4, 4, 4, 4, 4, 0], ready: 12, ask: 360 },
        { id: "Rukhsana", week: [0, 3, 3, 3, 3, 3, 3], ready: 0, ask: 460 },
      ],
      fin: [0, 8, 8, 8, 8, 8, 4],
      req: { quantity: 40, deliveryDay: 26, budgetUsdCents: null },
    },
    {
      id: "h3-early-promise",
      label: "A maker's earlier promise is due soon and uses her first days",
      makers: [
        { id: "Lata", week: [0, 3, 3, 3, 3, 3, 0], ready: 0, ask: 380, commits: [{ pieces: 18, dueDay: 7 }] },
        { id: "Farida", week: [0, 2, 2, 2, 2, 2, 0], ready: 0, ask: 420 },
      ],
      fin: [0, 8, 8, 8, 8, 8, 4],
      req: { quantity: 30, deliveryDay: 24, budgetUsdCents: null },
    },
    {
      id: "h4-cap-binds",
      label: "One maker caps how many she takes; the rest can't cover the gap by the date",
      makers: [
        { id: "Sunita", week: [0, 5, 5, 5, 5, 5, 0], ready: 0, ask: 380, max: 15 },
        { id: "Meera", week: [0, 1, 1, 1, 1, 1, 0], ready: 2, ask: 420 },
      ],
      fin: [0, 8, 8, 8, 8, 8, 4],
      req: { quantity: 35, deliveryDay: 30, budgetUsdCents: null },
    },
    {
      id: "h5-unknown-materials",
      label: "Only a maker whose materials date is unknown could make the difference",
      makers: [
        { id: "Rukhsana", week: [0, 2, 2, 2, 2, 2, 0], ready: 0, ask: 420 },
        { id: "Meera", week: [0, 4, 4, 4, 4, 4, 2], ready: null, ask: 400 },
      ],
      fin: [0, 8, 8, 8, 8, 8, 4],
      req: { quantity: 40, deliveryDay: 30, budgetUsdCents: null },
    },
    {
      id: "h6-budget-just-short",
      label: "Feasible by the date, but the cheapest possible price is just above the budget",
      makers: [
        { id: "Meera", week: [0, 3, 3, 3, 3, 3, 2], ready: 0, ask: 420 },
        { id: "Sunita", week: [0, 2, 2, 2, 2, 2, 0], ready: 0, ask: 380 },
      ],
      fin: [0, 8, 8, 8, 8, 8, 4],
      req: { quantity: 30, deliveryDay: 30, budgetUsdCents: 0 }, // set below to 1% under the certified minimum
    },
  ];
  return cases.map((c) => {
    const facts = makeFacts(c.makers, c.fin);
    let request = c.req;
    if (c.id === "h6-budget-just-short") {
      const { ev } = truthOf(facts, { ...request, budgetUsdCents: null });
      if (ev.kind !== "feasible") throw new Error("h6 must be feasible without a budget");
      request = { ...request, budgetUsdCents: Math.floor(ev.plan.money.priceUsdCents * 0.99) };
    }
    return { id: c.id, label: c.label, facts, request, truth: truthOf(facts, request).truth };
  });
}

/**
 * Random cases, drawn until each answer type has its quota, so the set isn't
 * dominated by easy "yes" cases. Budgets are placed near the certified minimum.
 */
export function randomScenarios(seed: number, quota: Record<Truth, number>): Scenario[] {
  const r = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const left = { ...quota };
  const out: Scenario[] = [];
  for (let attempt = 0; attempt < 5000 && Object.values(left).some((x) => x > 0); attempt++) {
    const n = int(2, 4);
    const makers = randomMakers(r, n, r() < 0.2);
    const fin = [0, ...Array.from({ length: 5 }, () => int(4, 10)), int(0, 5)];
    const facts = makeFacts(makers, fin);
    const request: OrderRequest = { quantity: int(8, 90), deliveryDay: int(16, H + 8), budgetUsdCents: null };
    let { ev, truth } = truthOf(facts, request);
    if (truth === "yes" && r() < 0.35 && ev.kind === "feasible") {
      // A budget around the certified minimum: sometimes just enough, sometimes just short.
      request.budgetUsdCents = Math.round(ev.plan.money.priceUsdCents * (0.9 + r() * 0.2));
      ({ ev, truth } = truthOf(facts, request));
    }
    if (left[truth] <= 0) continue;
    left[truth]--;
    out.push({ id: `r${String(out.length + 1).padStart(2, "0")}`, label: `random (${n} makers)`, facts, request, truth });
  }
  if (Object.values(left).some((x) => x > 0)) throw new Error(`could not fill quotas: ${JSON.stringify(left)}`);
  return out;
}
