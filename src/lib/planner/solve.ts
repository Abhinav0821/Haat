import { FlowGraph, INF } from "./flow";
import {
  PLANNER_MODEL,
  factsHash,
  type Alternatives,
  type CollectiveFacts,
  type CutCert,
  type Evaluation,
  type FinishingEntry,
  type Issue,
  type Money,
  type OptimalityCert,
  type OrderRequest,
  type Plan,
  type ProductionEntry,
  type Sourced,
} from "./model";

/**
 * Solver for model M1 (docs/planner-model.md). Builds a time-expanded network from the
 * facts, computes maximum quantities, minimum-cost plans, capacity cuts and optimality
 * certificates. Its outputs are verified by check.ts, which shares none of this code.
 */

type DMaker = {
  id: string;
  ask: number;
  ready: number;
  cap: number[]; // after reservations
  commits: { pieces: number; due: number }[];
  P: number;
  maxPieces: number | null;
};
export type Instance = { H: number; lag: number; fin: number[]; makers: DMaker[] };
type Derived = { inst: Instance; issues: Issue[]; blocking: boolean; incomplete: boolean; lastFinish: number; beyondHorizon: boolean };

const DAY_MS = 86_400_000;
const isCount = (n: unknown) => Number.isInteger(n) && (n as number) >= 0;

function staleness<T>(f: Sourced<T>, now: Date, days: number): boolean {
  return f.prov.source === "maker_confirmed" && now.getTime() - Date.parse(f.prov.at) > days * DAY_MS;
}

/** Undated promises are due first-in-first-out on her earliest capacity; returns null if they don't fit. */
function withDueDays(cap: number[], commits: { pieces: number; dueDay: number | null }[]): { pieces: number; due: number }[] | null {
  const out: { pieces: number; due: number }[] = [];
  let need = 0;
  for (const c of commits) {
    if (c.dueDay !== null) {
      out.push({ pieces: c.pieces, due: c.dueDay });
      continue;
    }
    need += c.pieces;
    let cum = 0;
    let due = -1;
    for (let t = 0; t < cap.length; t++) {
      cum += cap[t];
      if (cum >= need) {
        due = t;
        break;
      }
    }
    if (due < 0) return null;
    out.push({ pieces: c.pieces, due });
  }
  return out;
}

function edfOk(cap: number[], commits: { pieces: number; due: number }[]): boolean {
  const sorted = [...commits].sort((a, b) => a.due - b.due);
  let demand = 0;
  for (const c of sorted) {
    if (c.due < 0) return false;
    demand += c.pieces;
    let supply = 0;
    for (let t = 0; t <= Math.min(c.due, cap.length - 1); t++) supply += cap[t];
    if (supply < demand) return false;
  }
  return true;
}

const issue = (code: Issue["code"], fact: string, en: string, hi: string, makerId?: string): Issue => ({ code, fact, en, hi, ...(makerId ? { makerId } : {}) });

export function derive(facts: CollectiveFacts, request: OrderRequest, now: Date): Derived {
  const H = facts.horizonDays;
  const issues: Issue[] = [];
  let blocking = false;
  let incomplete = false;

  if (!Number.isInteger(request.quantity) || request.quantity < 1) {
    issues.push(issue("inconsistent", "quantity", "The quantity must be a whole number of at least 1.", "मात्रा कम से कम 1 होनी चाहिए।"));
    blocking = true;
  }
  const fin = [...facts.finishingPerDay.value];
  if (fin.length !== H || !fin.every(isCount)) {
    issues.push(issue("inconsistent", "finishingPerDay", "Finishing capacity must list a whole number for every day of the horizon.", "फ़िनिशिंग की क्षमता हर दिन के लिए चाहिए।"));
    blocking = true;
  }
  for (const r of facts.reservations) {
    for (const f of r.finishing) if (f.day >= 0 && f.day < H) fin[f.day] -= f.pieces;
  }
  if (fin.some((x) => x < 0)) {
    issues.push(issue("inconsistent", "reservations", "Reserved finishing exceeds the finishing capacity on some day.", "किसी दिन फ़िनिशिंग की बुकिंग क्षमता से ज़्यादा है।"));
    blocking = true;
  }
  if (staleness(facts.finishingPerDay, now, facts.staleAfterDays)) {
    issues.push(issue("stale", "finishingPerDay", "Finishing capacity needs re-confirming.", "फ़िनिशिंग की क्षमता फिर से पक्की करें।"));
    blocking = true;
  }

  const makers: DMaker[] = [];
  for (const m of facts.makers) {
    const name = m.name;
    if (!m.capable.value) {
      issues.push(issue("excluded", "capable", `${name} has not confirmed she can make this item.`, `${name} ने यह चीज़ बना पाने की पुष्टि नहीं की है।`, m.id));
      continue;
    }
    if (m.fixedCostInr > 0) {
      issues.push(issue("unsupported", "fixedCostInr", `${name}'s per-order cost (₹${m.fixedCostInr}) can't be modelled yet; enter it per piece.`, `${name} का एक बार का खर्च अभी हर पीस के हिसाब से डालें।`, m.id));
      blocking = true;
      continue;
    }
    const cap0 = m.dailyCapacity.value;
    if (cap0.length !== H || !cap0.every(isCount)) {
      issues.push(issue("inconsistent", "dailyCapacity", `${name}'s daily capacity is incomplete.`, `${name} की रोज़ की क्षमता अधूरी है।`, m.id));
      incomplete = true;
      continue;
    }
    const cap = [...cap0];
    for (const r of facts.reservations) for (const p of r.production) if (p.makerId === m.id && p.day >= 0 && p.day < H) cap[p.day] -= p.pieces;
    if (cap.some((x) => x < 0)) {
      issues.push(issue("inconsistent", "reservations", `${name} is booked beyond her capacity on some day.`, `${name} किसी दिन क्षमता से ज़्यादा बुक हैं।`, m.id));
      incomplete = true;
      continue;
    }
    if (m.askInrPerPiece.value < m.floorInrPerPiece.value) {
      issues.push(issue("inconsistent", "askInrPerPiece", `${name}'s asking price is below her own minimum.`, `${name} का माँगा दाम उनके न्यूनतम से कम है।`, m.id));
      incomplete = true;
      continue;
    }
    if (!m.materialsReadyDay) {
      issues.push(issue("missing", "materialsReadyDay", `When will ${name}'s materials be ready?`, `${name} का सामान कब तक आ जाएगा?`, m.id));
      incomplete = true;
      continue;
    }
    if (staleness(m.dailyCapacity, now, facts.staleAfterDays) || staleness(m.commitments, now, facts.staleAfterDays)) {
      issues.push(issue("stale", "availability", `${name}'s availability and other promises need re-confirming.`, `${name} से उनका समय और बाकी वादे फिर से पूछें।`, m.id));
      incomplete = true;
      continue;
    }
    const commits = withDueDays(cap, m.commitments.value);
    if (!commits || !edfOk(cap, commits)) {
      issues.push(issue("inconsistent", "commitments", `${name}'s existing promises don't fit her stated capacity — please confirm both.`, `${name} के पुराने वादे उनकी क्षमता में नहीं समाते — दोनों पक्के करें।`, m.id));
      incomplete = true;
      continue;
    }
    for (const f of [m.dailyCapacity, m.materialsReadyDay, m.askInrPerPiece] as Sourced<unknown>[]) {
      if (f.prov.source === "coordinator_entered") {
        issues.push(issue("estimate", "provenance", `Some of ${name}'s facts were entered by the coordinator and are not yet confirmed by her.`, `${name} की कुछ जानकारी संयोजक ने डाली है — उनसे पुष्टि बाकी है।`, m.id));
        break;
      }
    }
    makers.push({
      id: m.id,
      ask: m.askInrPerPiece.value,
      ready: Math.max(0, m.materialsReadyDay.value),
      cap,
      commits,
      P: commits.reduce((s, c) => s + c.pieces, 0),
      maxPieces: m.maxPieces ? m.maxPieces.value : null,
    });
  }

  const lastFinish = request.deliveryDay - facts.transitDays.value - facts.packDays - 1;
  return {
    inst: { H, lag: facts.lagDays, fin: fin.map((x) => Math.max(0, x)), makers },
    issues,
    blocking,
    incomplete,
    lastFinish,
    beyondHorizon: lastFinish > H - 1,
  };
}

// ---------- network ----------

type Built = { g: FlowGraph; s: number; Tc: number; To: number; P: number; prod: { id: string; day: number; e: number }[]; finE: { day: number; e: number }[] };

function build(inst: Instance, makers: DMaker[], lastFinish: number, gates?: Map<string, number>): Built {
  const L = Math.min(lastFinish, inst.H - 1);
  const H = inst.H;
  let n = 3;
  const gNode = makers.map(() => n++);
  const dayNode = makers.map(() => {
    const base = n;
    n += H;
    return base;
  });
  const kNode = makers.map((m) => m.commits.map(() => n++));
  const wBase = n;
  n += Math.max(0, L + 1);
  const g = new FlowGraph(n);
  const s = 0,
    Tc = 1,
    To = 2;
  const prod: Built["prod"] = [];
  const finE: Built["finE"] = [];
  let P = 0;
  makers.forEach((m, i) => {
    P += m.P;
    const share = gates?.get(m.id) ?? m.maxPieces;
    g.addEdge(s, gNode[i], share === null || share === undefined ? INF : share + m.P);
    for (let t = 0; t < H; t++) {
      if (m.cap[t] <= 0) continue;
      const v = dayNode[i] + t;
      g.addEdge(gNode[i], v, m.cap[t]);
      m.commits.forEach((c, k) => {
        if (t <= c.due) g.addEdge(v, kNode[i][k], INF);
      });
      if (t >= m.ready && t + inst.lag <= L) prod.push({ id: m.id, day: t, e: g.addEdge(v, wBase + t + inst.lag, INF, m.ask) });
    }
    m.commits.forEach((c, k) => g.addEdge(kNode[i][k], Tc, c.pieces));
  });
  for (let t = 0; t <= L; t++) {
    if (t < L) g.addEdge(wBase + t, wBase + t + 1, INF);
    if (inst.fin[t] > 0) finE.push({ day: t, e: g.addEdge(wBase + t, To, inst.fin[t]) });
  }
  return { g, s, Tc, To, P, prod, finE };
}

function serveCommitments(b: Built) {
  const served = b.g.maxflow(b.s, b.Tc);
  if (served !== b.P) throw new Error("commitments not servable — derive() should have caught this");
}

export function maxOrder(inst: Instance, makers: DMaker[], lastFinish: number): number {
  if (lastFinish < 0) return 0;
  const b = build(inst, makers, lastFinish);
  serveCommitments(b);
  return b.g.maxflow(b.s, b.To);
}

/** Minimum cut by enumerating the (τ, u) family of docs §3. */
export function minCut(inst: Instance, makers: DMaker[], lastFinish: number): CutCert {
  const L = Math.min(lastFinish, inst.H - 1);
  const H = inst.H;
  const prefix = makers.map((m) => {
    const p = [0];
    for (let t = 0; t < H; t++) p.push(p[t] + m.cap[t]);
    return p;
  });
  const finSuffix = new Array(Math.max(0, L + 2)).fill(0);
  for (let t = L; t >= 0; t--) finSuffix[t] = finSuffix[t + 1] + inst.fin[t];
  let best: CutCert | null = null;
  for (let tau = 0; tau <= Math.max(0, L + 1); tau++) {
    let bound = L >= 0 ? finSuffix[tau] : 0;
    const choice: CutCert["makers"] = [];
    makers.forEach((m, i) => {
      const pre = prefix[i];
      const hi = Math.min(H, tau - inst.lag); // days t ≤ τ−lag−1  ⇔  t < τ−lag
      let bestV = Infinity;
      let bestU: number | "cap" = H;
      for (let u = 0; u <= H; u++) {
        const lo = Math.max(u, m.ready);
        const late = hi > lo ? pre[hi] - pre[lo] : 0;
        const dueBefore = m.commits.reduce((s, c) => (c.due < u ? s + c.pieces : s), 0);
        const v = pre[u] + late - dueBefore;
        if (v < bestV) {
          bestV = v;
          bestU = u;
        }
      }
      if (m.maxPieces !== null && m.maxPieces < bestV) {
        bestV = m.maxPieces;
        bestU = "cap";
      }
      bound += bestV;
      choice.push({ makerId: m.id, u: bestU });
    });
    if (!best || bound < best.bound) best = { lastFinishDay: lastFinish, tau, makers: choice, bound };
  }
  return best!;
}

function planEntries(inst: Instance, makers: DMaker[], Q: number, lastFinish: number, gates?: Map<string, number>): { production: ProductionEntry[]; finishing: FinishingEntry[] } | null {
  if (lastFinish < 0) return null;
  const b = build(inst, makers, lastFinish, gates);
  serveCommitments(b);
  const r = b.g.minCostFlow(b.s, b.To, Q);
  if (r.flow < Q) return null;
  const production = b.prod.map((p) => ({ makerId: p.id, day: p.day, pieces: b.g.flowOn(p.e) })).filter((p) => p.pieces > 0);
  const finishing = b.finE.map((f) => ({ day: f.day, pieces: b.g.flowOn(f.e) })).filter((f) => f.pieces > 0);
  return { production, finishing };
}

// ---------- money ----------

export function feeUsdCents(p: number, fee: CollectiveFacts["fee"]) {
  return Math.round((p * fee.percent) / 100) + fee.fixedUsdCents;
}
export function netInr(p: number, fee: CollectiveFacts["fee"], rate: number) {
  return Math.round(((p - feeUsdCents(p, fee)) / 100) * rate);
}
export function priceFor(totalCostInr: number, fee: CollectiveFacts["fee"], rate: number): number {
  const est = Math.ceil(((totalCostInr / rate) * 100 + fee.fixedUsdCents) / (1 - fee.percent / 100));
  let p = Math.max(0, est - 50);
  while (netInr(p, fee, rate) < totalCostInr) p++;
  while (p > 0 && netInr(p - 1, fee, rate) >= totalCostInr) p--;
  return p;
}

function money(facts: CollectiveFacts, inst: Instance, production: ProductionEntry[], Q: number): Money {
  const pieces = new Map<string, number>();
  for (const p of production) pieces.set(p.makerId, (pieces.get(p.makerId) ?? 0) + p.pieces);
  const perMaker = inst.makers
    .filter((m) => pieces.has(m.id))
    .map((m) => ({ makerId: m.id, pieces: pieces.get(m.id)!, payInr: m.ask * pieces.get(m.id)! }));
  const c = facts.costs;
  const makersInr = perMaker.reduce((s, x) => s + x.payInr, 0);
  const totalCostInr =
    makersInr + (c.finishingInrPerPiece + c.packagingInrPerPiece + c.collectionInrPerPiece + c.chargeInrPerPiece) * Q + c.shippingInrPerOrder;
  const priceUsdCents = priceFor(totalCostInr, facts.fee, facts.inrPerUsd.value);
  return {
    perMaker,
    makersInr,
    finishingInr: c.finishingInrPerPiece * Q,
    packagingInr: c.packagingInrPerPiece * Q,
    collectionInr: c.collectionInrPerPiece * Q,
    chargeInr: c.chargeInrPerPiece * Q,
    shippingInr: c.shippingInrPerOrder,
    totalCostInr,
    priceUsdCents,
    estFeeUsdCents: feeUsdCents(priceUsdCents, facts.fee),
  };
}

function optimality(inst: Instance, plan: Plan, lastFinish: number): { cert: OptimalityCert; certified: boolean } {
  const x = new Map(plan.money.perMaker.map((p) => [p.makerId, p.pieces]));
  const asks = [...new Set(inst.makers.map((m) => m.ask))].sort((a, b) => a - b);
  const levels: OptimalityCert["levels"] = [];
  let certified = true;
  for (const level of asks.slice(0, -1)) {
    const group = inst.makers.filter((m) => m.ask <= level);
    const xP = group.reduce((s, m) => s + (x.get(m.id) ?? 0), 0);
    if (xP === plan.quantity) {
      levels.push({ askInr: level, makerIds: group.map((m) => m.id), cut: null });
      continue;
    }
    const cut = minCut(inst, group, lastFinish);
    if (cut.bound !== xP) certified = false;
    levels.push({ askInr: level, makerIds: group.map((m) => m.id), cut });
  }
  return { cert: { levels }, certified };
}

function makePlan(facts: CollectiveFacts, inst: Instance, request: OrderRequest, Q: number, deliveryDay: number): Plan | null {
  const lastFinish = deliveryDay - facts.transitDays.value - facts.packDays - 1;
  const e = planEntries(inst, inst.makers, Q, lastFinish);
  if (!e) return null;
  return {
    model: PLANNER_MODEL,
    factsHash: factsHash(facts, { quantity: Q, deliveryDay, budgetUsdCents: request.budgetUsdCents }),
    quantity: Q,
    deliveryDay,
    lastFinishDay: lastFinish,
    production: e.production,
    finishing: e.finishing,
    money: money(facts, inst, e.production, Q),
  };
}

// ---------- evaluation ----------

export function evaluate(facts: CollectiveFacts, request: OrderRequest, now: Date): Evaluation {
  let d: Derived;
  try {
    d = derive(facts, request, now);
  } catch (err) {
    return { kind: "unresolved", issues: [issue("error", "derive", `Planning failed: ${(err as Error).message}`, "योजना बनाने में गड़बड़ी हुई।")] };
  }
  if (d.blocking) return { kind: "unresolved", issues: d.issues };
  try {
    return decide(facts, request, d);
  } catch (err) {
    return { kind: "unresolved", issues: [...d.issues, issue("error", "solver", `Planning failed: ${(err as Error).message}`, "योजना बनाने में गड़बड़ी हुई।")] };
  }
}

function decide(facts: CollectiveFacts, request: OrderRequest, d: Derived): Evaluation {
  const { inst } = d;
  const Q = request.quantity;
  const L = d.lastFinish;
  const notes = d.issues;
  const maxQ = maxOrder(inst, inst.makers, L);

  if (maxQ >= Q) {
    const plan = makePlan(facts, inst, request, Q, request.deliveryDay)!;
    const { cert, certified } = optimality(inst, plan, L);
    const budget = request.budgetUsdCents;
    if (budget !== null && plan.money.priceUsdCents > budget) {
      return {
        kind: "infeasible_budget",
        plan,
        optimality: cert,
        certified,
        budgetUsdCents: budget,
        alternatives: { largestWithinBudget: largestWithinBudget(facts, inst, request, Q - 1, budget) },
        notes,
      };
    }
    return { kind: "feasible", plan, optimality: cert, certified, notes };
  }

  // A refusal needs complete facts for everyone who could contribute, inside the horizon.
  if (d.incomplete || d.beyondHorizon) {
    const extra = d.beyondHorizon
      ? [issue("beyond_horizon", "deliveryDay", `Availability is only known for the next ${inst.H} days.`, `सिर्फ़ अगले ${inst.H} दिनों का समय पता है।`)]
      : [];
    return { kind: "unresolved", issues: [...d.issues, ...extra], partial: { maxQuantity: maxQ } };
  }

  const cut = minCut(inst, inst.makers, L);
  if (cut.bound !== maxQ) throw new Error(`cut ${cut.bound} ≠ max flow ${maxQ}`);
  const alternatives: Alternatives = {};
  const bestPlan = maxQ > 0 ? makePlan(facts, inst, request, maxQ, request.deliveryDay) : null;
  const bestOpt = bestPlan ? optimality(inst, bestPlan, L) : null;
  alternatives.largestByDate = { quantity: maxQ, plan: bestPlan, cut, optimality: bestOpt?.cert ?? null, certified: bestOpt?.certified ?? true };
  alternatives.earliestDelivery = earliestDelivery(facts, inst, request);
  return { kind: "infeasible_capacity", requested: Q, maxQuantity: maxQ, cut, alternatives, notes };
}

function earliestDelivery(facts: CollectiveFacts, inst: Instance, request: OrderRequest): Alternatives["earliestDelivery"] {
  const offset = facts.transitDays.value + facts.packDays + 1;
  const lastDelivery = inst.H - 1 + offset; // lastFinish = H − 1
  const fits = (dd: number) => maxOrder(inst, inst.makers, dd - offset) >= request.quantity;
  if (request.deliveryDay >= lastDelivery || !fits(lastDelivery)) {
    return { kind: "not_within_horizon", horizonDays: inst.H, cut: minCut(inst, inst.makers, inst.H - 1) };
  }
  // With the recorded facts held fixed, a later date never removes capacity: binary search.
  let lo = request.deliveryDay + 1,
    hi = lastDelivery;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) hi = mid;
    else lo = mid + 1;
  }
  const L = lo - offset;
  const plan = makePlan(facts, inst, request, request.quantity, lo)!;
  const { cert, certified } = optimality(inst, plan, L);
  return { kind: "found", plan, dayBeforeCut: minCut(inst, inst.makers, L - 1), optimality: cert, certified };
}

function largestWithinBudget(facts: CollectiveFacts, inst: Instance, request: OrderRequest, upTo: number, budget: number): Alternatives["largestWithinBudget"] {
  const L = request.deliveryDay - facts.transitDays.value - facts.packDays - 1;
  let lo = 0,
    hi = upTo; // invariant: price(lo) ≤ budget (lo = 0 trivially)
  let best: Plan | null = null;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const p = makePlan(facts, inst, request, mid, request.deliveryDay);
    if (p && p.money.priceUsdCents <= budget) {
      lo = mid;
      best = p;
    } else hi = mid - 1;
  }
  if (lo === 0) return { quantity: 0 };
  best = best && best.quantity === lo ? best : makePlan(facts, inst, request, lo, request.deliveryDay)!;
  const { cert, certified } = optimality(inst, best, L);
  return { quantity: lo, plan: best, optimality: cert, certified };
}
