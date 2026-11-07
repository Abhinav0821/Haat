import { factsHash, withReadyDay, type CollectiveFacts, type CutCert, type DecidingQuestion, type Evaluation, type OptimalityCert, type OrderRequest, type Plan, type ThresholdRefusal } from "./model";
import { checkInputs, planShape, cutShape, optimalityShape, evaluationShape } from "./check-input";

/**
 * Independent checker for model M1 (docs/planner-model.md).
 *
 * It must be able to reject a plan produced by the solver, an LLM or a person. It
 * re-derives every capacity from the raw facts with its OWN code (no imports from
 * solve.ts or flow.ts) and verifies plans, capacity cuts and optimality certificates.
 */

type CMaker = {
  id: string;
  capable: boolean;
  complete: boolean; // usable facts (present, current, consistent)
  ask: number;
  floor: number;
  ready: number;
  free: number[]; // capacity after reservations
  dues: { pieces: number; due: number }[];
  maxPieces: number | null;
};
type View = { H: number; lag: number; finishing: number[]; makers: Map<string, CMaker>; ok: boolean; problems: string[] };

const DAY = 86_400_000;

function view(facts: CollectiveFacts, now: Date): View {
  const problems: string[] = [];
  const H = facts.horizonDays;
  const finishing = facts.finishingPerDay.value.slice();
  if (finishing.length !== H) problems.push("finishing capacity length ≠ horizon");
  facts.reservations.forEach((r) => r.finishing.forEach((f) => (finishing[f.day] = (finishing[f.day] ?? 0) - f.pieces)));
  if (finishing.some((x) => !(Number.isInteger(x) && x >= 0))) problems.push("finishing capacity invalid after reservations");
  if (facts.finishingPerDay.prov.source === "maker_confirmed" && now.getTime() - Date.parse(facts.finishingPerDay.prov.at) > facts.staleAfterDays * DAY) problems.push("finishing capacity stale");

  const makers = new Map<string, CMaker>();
  for (const m of facts.makers) {
    const free = m.dailyCapacity.value.slice();
    facts.reservations.forEach((r) => r.production.forEach((p) => p.makerId === m.id && (free[p.day] = (free[p.day] ?? 0) - p.pieces)));
    const stale = [m.dailyCapacity.prov, m.commitments.prov].some((p) => p.source === "maker_confirmed" && now.getTime() - Date.parse(p.at) > facts.staleAfterDays * DAY);
    // Undated promises: due when her running capacity first covers the running total of undated pieces.
    const dues: { pieces: number; due: number }[] = [];
    let undated = 0;
    let duesOk = true;
    for (const c of m.commitments.value) {
      if (c.dueDay !== null) {
        dues.push({ pieces: c.pieces, due: c.dueDay });
        continue;
      }
      undated += c.pieces;
      let run = 0;
      let at = -1;
      free.some((x, t) => ((run += x), run >= undated ? ((at = t), true) : false));
      if (at < 0) duesOk = false;
      dues.push({ pieces: c.pieces, due: at });
    }
    const valid =
      free.length === H &&
      free.every((x) => Number.isInteger(x) && x >= 0) &&
      m.askInrPerPiece.value >= m.floorInrPerPiece.value &&
      m.materialsReadyDay !== null &&
      !stale &&
      duesOk &&
      m.fixedCostInr === 0 &&
      promisesFit(free, dues);
    makers.set(m.id, {
      id: m.id,
      capable: m.capable.value,
      complete: valid,
      ask: m.askInrPerPiece.value,
      floor: m.floorInrPerPiece.value,
      ready: Math.max(0, m.materialsReadyDay?.value ?? 0),
      free,
      dues,
      maxPieces: m.maxPieces ? m.maxPieces.value : null,
    });
  }
  return { H, lag: facts.lagDays, finishing, makers, ok: problems.length === 0, problems };
}

/** Exact for unit pieces: every deadline prefix has enough capacity for the promises due by then. */
function promisesFit(free: number[], dues: { pieces: number; due: number }[]): boolean {
  const deadlines = [...new Set(dues.map((d) => d.due))];
  return deadlines.every((d) => {
    if (d < 0) return false;
    const need = dues.filter((x) => x.due <= d).reduce((s, x) => s + x.pieces, 0);
    const have = free.slice(0, d + 1).reduce((s, x) => s + x, 0);
    return have >= need;
  });
}

function lastFinishOf(facts: CollectiveFacts, deliveryDay: number) {
  return deliveryDay - facts.transitDays.value - facts.packDays - 1;
}

function fee(p: number, facts: CollectiveFacts) {
  return Math.round((p * facts.fee.percent) / 100) + facts.fee.fixedUsdCents;
}
function net(p: number, facts: CollectiveFacts) {
  return Math.round(((p - fee(p, facts)) / 100) * facts.inrPerUsd.value);
}

export function checkPlan(facts: CollectiveFacts, request: OrderRequest, plan: Plan, now: Date): string[] {
  const invalid = [...checkInputs(facts, request, now), ...planShape(plan)];
  if (invalid.length) return invalid;
  const v = view(facts, now);
  const bad: string[] = [...v.problems];
  if (plan.quantity !== request.quantity || plan.deliveryDay !== request.deliveryDay) bad.push("plan doesn't answer the request");
  if (plan.factsHash !== factsHash(facts, request)) bad.push("plan was made against different facts or request");
  const last = lastFinishOf(facts, plan.deliveryDay);
  if (plan.lastFinishDay !== last) bad.push("last finishing day does not follow from delivery, transit and packing");
  const lastUsable = Math.min(last, v.H - 1);

  const made = new Map<string, number[]>();
  for (const p of plan.production) {
    const m = v.makers.get(p.makerId);
    if (!Number.isInteger(p.pieces) || p.pieces <= 0) bad.push(`non-positive or fractional production for ${p.makerId}`);
    if (!m) {
      bad.push(`unknown maker ${p.makerId}`);
      continue;
    }
    if (!m.capable) bad.push(`${p.makerId} has not confirmed she can make this`);
    if (!m.complete) bad.push(`${p.makerId}'s facts are missing, stale or inconsistent`);
    if (p.day < m.ready) bad.push(`${p.makerId} produces on day ${p.day}, before her materials are ready (day ${m.ready})`);
    if (p.day < 0 || p.day >= v.H) bad.push(`production day ${p.day} outside the horizon`);
    const row = made.get(p.makerId) ?? new Array(v.H).fill(0);
    row[p.day] += p.pieces;
    made.set(p.makerId, row);
  }
  let produced = 0;
  for (const [id, row] of made) {
    const m = v.makers.get(id)!;
    row.forEach((x, t) => x > (m.free[t] ?? 0) && bad.push(`${id} is over capacity on day ${t}`));
    const left = m.free.map((x, t) => x - row[t]);
    if (!promisesFit(left, m.dues)) bad.push(`${id}'s other promises no longer fit`);
    const total = row.reduce((s, x) => s + x, 0);
    if (m.maxPieces !== null && total > m.maxPieces) bad.push(`${id} gets ${total}, above her limit of ${m.maxPieces}`);
    produced += total;
  }

  const fin = new Array(v.H).fill(0);
  for (const f of plan.finishing) {
    if (!Number.isInteger(f.pieces) || f.pieces <= 0) bad.push("non-positive finishing entry");
    if (f.day < 0 || f.day > lastUsable) bad.push(`finishing on day ${f.day} is after the last finishing day`);
    else fin[f.day] += f.pieces;
  }
  fin.forEach((x, t) => x > (v.finishing[t] ?? 0) && bad.push(`finishing over capacity on day ${t}`));
  // Precedence: by every day, finished ≤ produced at least `lag` days earlier.
  let cumFin = 0;
  for (let t = 0; t < v.H; t++) {
    cumFin += fin[t];
    let ready = 0;
    for (const row of made.values()) for (let u = 0; u <= t - v.lag; u++) ready += row[u];
    if (cumFin > ready) {
      bad.push(`day ${t}: ${cumFin} finished but only ${ready} made in time`);
      break;
    }
  }
  const finished = fin.reduce((s, x) => s + x, 0);
  if (produced !== plan.quantity) bad.push(`produced ${produced} ≠ quantity ${plan.quantity}`);
  if (finished !== plan.quantity) bad.push(`finished ${finished} ≠ quantity ${plan.quantity}`);

  // Money, recomputed.
  const c = facts.costs;
  let makersInr = 0;
  for (const [id, row] of made) makersInr += v.makers.get(id)!.ask * row.reduce((s, n) => s + n, 0);
  const paid = new Set<string>();
  for (const pm of plan.money.perMaker) {
    const m = v.makers.get(pm.makerId);
    const pieces = (made.get(pm.makerId) ?? []).reduce((s, x) => s + x, 0);
    if (paid.has(pm.makerId)) bad.push(`duplicate pay line for ${pm.makerId}`);
    paid.add(pm.makerId);
    if (!m || !made.has(pm.makerId)) { bad.push(`pay line for non-producing or unknown maker ${pm.makerId}`); continue; }
    if (pm.pieces !== pieces) bad.push(`${pm.makerId}: paid for ${pm.pieces}, makes ${pieces}`);
    if (pm.payInr !== m.ask * pieces) bad.push(`${pm.makerId}: pay ≠ her asking price × pieces`);
    if (pm.payInr < m.floor * pieces) bad.push(`${pm.makerId}: pay below her minimum`);
  }
  for (const id of made.keys()) if (!paid.has(id)) bad.push(`missing pay line for ${id}`);
  const total =
    makersInr + (c.finishingInrPerPiece + c.packagingInrPerPiece + c.collectionInrPerPiece + c.chargeInrPerPiece) * plan.quantity + c.shippingInrPerOrder;
  if (plan.money.totalCostInr !== total) bad.push(`total cost ₹${plan.money.totalCostInr} ≠ recomputed ₹${total}`);
  const expected = {
    makersInr, finishingInr: c.finishingInrPerPiece * plan.quantity, packagingInr: c.packagingInrPerPiece * plan.quantity,
    collectionInr: c.collectionInrPerPiece * plan.quantity, chargeInr: c.chargeInrPerPiece * plan.quantity,
    shippingInr: c.shippingInrPerOrder, estFeeUsdCents: fee(plan.money.priceUsdCents, facts),
  };
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) if (plan.money[key] !== expected[key]) bad.push(`money.${key} differs from recomputed amount`);
  const P = plan.money.priceUsdCents;
  if (net(P, facts) < total) bad.push("price does not cover the total cost");
  if (P > 0 && net(P - 1, facts) >= total) bad.push("price is not the lowest that covers the cost");
  return bad;
}

/** Recomputes a cut's bound from raw facts (docs §3). `only` restricts to a subset of makers (optimality levels). */
export function cutBound(facts: CollectiveFacts, cut: CutCert, now: Date, only?: Set<string>): { bound: number; problems: string[] } {
  const invalid = [...checkInputs(facts, { quantity: 1, deliveryDay: 0, budgetUsdCents: null }, now), ...cutShape(cut)];
  if (invalid.length) return { bound: 0, problems: invalid };
  const v = view(facts, now);
  const problems = [...v.problems];
  const last = Math.min(cut.lastFinishDay, v.H - 1);
  if (cut.tau > Math.max(0, last + 1)) problems.push("cut tau is outside its date range");
  let bound = 0;
  for (let t = Math.max(0, cut.tau); t <= last; t++) bound += v.finishing[t];
  const listed = new Set(cut.makers.map((m) => m.makerId));
  if (listed.size !== cut.makers.length) problems.push("duplicate maker in cut");
  for (const m of v.makers.values()) {
    if (!m.capable || (only && !only.has(m.id))) continue;
    if (!listed.has(m.id)) problems.push(`cut omits ${m.id}, who could contribute`);
  }
  for (const c of cut.makers) {
    const m = v.makers.get(c.makerId);
    if (!m || !m.capable || (only && !only.has(m.id))) {
      problems.push(`cut lists ${c.makerId}, who is not in scope`);
      continue;
    }
    if (!m.complete) problems.push(`${m.id}'s facts are incomplete, so a refusal can't rely on them`);
    if (c.u === "cap") {
      if (m.maxPieces === null) problems.push(`${m.id} has no limit to cut on`);
      bound += m.maxPieces ?? Infinity;
      continue;
    }
    const u = c.u;
    if (u > v.H) problems.push("cut u is outside the horizon");
    let contribution = 0;
    m.free.forEach((x, t) => {
      if (t < u) contribution += x;
      else if (t >= m.ready && t <= cut.tau - v.lag - 1) contribution += x;
    });
    for (const d of m.dues) if (d.due < u) contribution -= d.pieces;
    bound += contribution;
  }
  return { bound, problems };
}

/** A capacity refusal: the recomputed bound must be below the requested quantity. */
export function checkRefusal(facts: CollectiveFacts, request: OrderRequest, cut: CutCert, now: Date): string[] {
  const invalid = [...checkInputs(facts, request, now), ...cutShape(cut)];
  if (invalid.length) return invalid;
  const bad: string[] = [];
  if (cut.lastFinishDay !== lastFinishOf(facts, request.deliveryDay)) bad.push("cut is for a different date");
  if (cut.lastFinishDay > facts.horizonDays - 1) bad.push("a refusal can't extend beyond the known horizon");
  const r = cutBound(facts, cut, now);
  bad.push(...r.problems);
  if (r.bound !== cut.bound) bad.push(`claimed bound ${cut.bound} ≠ recomputed ${r.bound}`);
  if (r.bound >= request.quantity) bad.push(`bound ${r.bound} does not rule out ${request.quantity}`);
  return bad;
}

/** Cheapest: for each price level, the plan's pieces from makers at or below it equal an upper bound. */
export function checkOptimality(facts: CollectiveFacts, plan: Plan, cert: OptimalityCert, now: Date): string[] {
  const invalid = [...checkInputs(facts, { quantity: 1, deliveryDay: 0, budgetUsdCents: null }, now), ...planShape(plan), ...optimalityShape(cert)];
  if (invalid.length) return invalid;
  const v = view(facts, now);
  const bad: string[] = [...v.problems];
  if ([...v.makers.values()].some((m) => m.capable && !m.complete)) bad.push("cheapest cannot be certified with incomplete maker facts");
  if (plan.lastFinishDay > v.H - 1) bad.push("cheapest cannot be certified beyond the known horizon");
  const usable = [...v.makers.values()].filter((m) => m.capable && m.complete);
  const x = new Map<string, number>();
  for (const p of plan.production) x.set(p.makerId, (x.get(p.makerId) ?? 0) + p.pieces);
  const asks = [...new Set(usable.map((m) => m.ask))].sort((a, b) => a - b).slice(0, -1);
  if (cert.levels.length !== asks.length) bad.push("certificate does not cover every price level");
  asks.forEach((ask, i) => {
    const level = cert.levels[i];
    const group = usable.filter((m) => m.ask <= ask).map((m) => m.id).sort();
    const supplied = level ? [...level.makerIds].sort() : [];
    if (!level || level.askInr !== ask || supplied.length !== group.length || supplied.some((id, n) => id !== group[n])) {
      bad.push(`price level ₹${ask}: wrong maker group`);
      return;
    }
    const xP = group.reduce((s, id) => s + (x.get(id) ?? 0), 0);
    if (xP === plan.quantity) return; // can't exceed the whole order
    if (!level.cut) {
      bad.push(`price level ₹${ask}: missing bound`);
      return;
    }
    if (level.cut.lastFinishDay !== plan.lastFinishDay) bad.push(`price level ₹${ask}: bound is for a different date`);
    const r = cutBound(facts, level.cut, now, new Set(group));
    bad.push(...r.problems.map((p) => `price level ₹${ask}: ${p}`));
    if (r.bound !== level.cut.bound) bad.push(`price level ₹${ask}: claimed cut bound differs from recomputed bound`);
    if (r.bound !== xP) bad.push(`price level ₹${ask}: plan uses ${xP} from cheaper makers but up to ${r.bound} are possible`);
  });
  return bad;
}

/** Checks a whole evaluation, including every alternative it offers. */
export function checkEvaluation(facts: CollectiveFacts, request: OrderRequest, ev: Evaluation, now: Date): string[] {
  const shape = evaluationShape(ev);
  if (shape.length) return shape;
  if (ev.kind === "unresolved") return [];
  const invalid = checkInputs(facts, request, now);
  if (invalid.length) return invalid;
  const bad: string[] = [];
  const plan = (p: Plan, opt: OptimalityCert | null, certified: boolean, label: string, quantity: number, deliveryDay: number) => {
    bad.push(...checkPlan(facts, { ...request, quantity, deliveryDay }, p, now).map((b) => `${label}: ${b}`));
    if (certified) {
      if (!opt) bad.push(`${label}: missing optimality certificate`);
      else bad.push(...checkOptimality(facts, p, opt, now).map((b) => `${label}: ${b}`));
    }
  };
  switch (ev.kind) {
    case "feasible":
      plan(ev.plan, ev.optimality, ev.certified, "plan", request.quantity, request.deliveryDay);
      if (request.budgetUsdCents !== null && ev.plan.money.priceUsdCents > request.budgetUsdCents) bad.push("feasible plan is over budget");
      break;
    case "infeasible_budget":
      plan(ev.plan, ev.optimality, ev.certified, "plan", request.quantity, request.deliveryDay);
      if (!ev.certified) bad.push("a budget refusal needs a certified minimum cost");
      if (request.budgetUsdCents === null || ev.budgetUsdCents !== request.budgetUsdCents) bad.push("budget refusal is for a different budget");
      if (request.budgetUsdCents !== null && ev.plan.money.priceUsdCents <= request.budgetUsdCents) bad.push("price is within budget");
      break;
    case "infeasible_capacity": {
      bad.push(...checkRefusal(facts, request, ev.cut, now));
      if (ev.requested !== request.quantity) bad.push("capacity refusal is for a different quantity");
      if (ev.cut.bound !== ev.maxQuantity) bad.push("max quantity ≠ cut bound");
      const lb = ev.alternatives.largestByDate;
      if (ev.maxQuantity > 0 && (!lb?.plan || lb.quantity !== ev.maxQuantity)) bad.push("maximum quantity needs a matching feasible plan");
      break;
    }
  }
  if (ev.kind === "feasible") return bad;
  // Every advertised alternative is checked, with an explicit transformed request.
  const lb = ev.alternatives.largestByDate;
  if (lb) {
    const r = { ...request, quantity: lb.quantity + 1 };
    bad.push(...checkRefusal(facts, r, lb.cut, now).map((b) => `largest by date: ${b}`));
    if (lb.cut.bound !== lb.quantity) bad.push("largest by date: quantity differs from cut bound");
    if (lb.quantity > request.quantity) bad.push("largest by date exceeds requested quantity");
    if (lb.quantity > 0) {
      if (!lb.plan) bad.push("largest by date: missing feasible plan");
      else plan(lb.plan, lb.optimality, lb.certified, "largest by date", lb.quantity, request.deliveryDay);
    } else if (lb.plan !== null || lb.optimality !== null) bad.push("zero quantity must not carry a production plan");
  }
  const ed = ev.alternatives.earliestDelivery;
  if (ed?.kind === "found") {
    plan(ed.plan, ed.optimality, ed.certified, "earliest delivery", request.quantity, ed.plan.deliveryDay);
    if (ed.plan.deliveryDay <= request.deliveryDay || ed.plan.lastFinishDay > facts.horizonDays - 1) bad.push("earliest delivery must be later than the refused date and inside the known horizon");
    if (!ed.dayBeforeCut) bad.push("earliest delivery requires a preceding-day refusal");
    else bad.push(...checkRefusal(facts, { ...request, deliveryDay: ed.plan.deliveryDay - 1 }, ed.dayBeforeCut, now).map((b) => `day before: ${b}`));
  }
  if (ed?.kind === "not_within_horizon") {
    const lastDelivery = facts.horizonDays + facts.transitDays.value + facts.packDays;
    if (ed.horizonDays !== facts.horizonDays) bad.push("earliest delivery: wrong horizon");
    bad.push(...checkRefusal(facts, { ...request, deliveryDay: lastDelivery }, ed.cut, now).map((b) => `horizon: ${b}`));
  }
  const budget = ev.alternatives.largestWithinBudget;
  if (budget) {
    if (request.budgetUsdCents === null) bad.push("budget alternative requires a budget");
    if (budget.quantity >= request.quantity) bad.push("budget alternative must be smaller than the refused quantity");
    if ("plan" in budget) {
      plan(budget.plan, budget.optimality, budget.certified, "within budget", budget.quantity, request.deliveryDay);
      if (budget.quantity === 0) bad.push("zero budget quantity cannot carry a plan");
      if (request.budgetUsdCents !== null && budget.plan.money.priceUsdCents > request.budgetUsdCents) bad.push("budget alternative exceeds the budget");
    } else if (budget.quantity !== 0) bad.push("budget alternative is missing its plan");
    const next = budget.next;
    plan(next.plan, next.optimality, true, "next quantity", budget.quantity + 1, request.deliveryDay);
    if (request.budgetUsdCents !== null && next.plan.money.priceUsdCents <= request.budgetUsdCents) bad.push("next quantity still fits the budget; alternative is not maximal");
  }
  return bad;
}

// ── Extension M1-Q1: one unknown materials date (docs/planner-model.md §8) ─────────

/** A refusal at a hypothetical date: the cut rules the quantity out, or the certified minimum price is above the budget. */
function checkThresholdRefusal(facts: CollectiveFacts, request: OrderRequest, r: ThresholdRefusal, now: Date, label: string): string[] {
  if (r.kind === "capacity") return checkRefusal(facts, request, r.cut, now).map((b) => `${label}: ${b}`);
  const bad = checkPlan(facts, request, r.plan, now).map((b) => `${label}: ${b}`);
  bad.push(...checkOptimality(facts, r.plan, r.optimality, now).map((b) => `${label}: ${b}`));
  if (request.budgetUsdCents === null) bad.push(`${label}: a budget refusal needs a budget`);
  else if (r.plan.money.priceUsdCents <= request.budgetUsdCents) bad.push(`${label}: the minimum price is within the budget`);
  return bad;
}

/**
 * Verifies a deciding question with this file's own capacity code. Scope is re-derived
 * from the raw facts: exactly one capable maker has no materials date, everyone else who
 * could contribute has complete facts, and the date lies inside the horizon. Monotonicity
 * in her date is a property of M1 (docs §8); the checker verifies the two endpoints.
 */
export function checkQuestion(facts: CollectiveFacts, request: OrderRequest, q: DecidingQuestion, now: Date): string[] {
  const invalid = checkInputs(facts, request, now);
  if (invalid.length) return invalid;
  const v = view(facts, now);
  const bad: string[] = [...v.problems];
  const unknown = facts.makers.filter((m) => m.capable.value && m.materialsReadyDay === null);
  if (unknown.length !== 1 || unknown[0].id !== q.makerId) bad.push("the question must be about the only unknown materials date");
  for (const m of v.makers.values()) {
    if (!m.capable || m.id === q.makerId) continue;
    if (!m.complete) bad.push(`${m.id}'s facts are incomplete, so one date cannot decide this`);
  }
  // Her other facts must be complete once the date is filled in.
  const filled = view(withReadyDay(facts, q.makerId, 0), now).makers.get(q.makerId);
  if (!filled || !filled.complete) bad.push(`${q.makerId}'s other facts are incomplete`);
  if (lastFinishOf(facts, request.deliveryDay) > v.H - 1) bad.push("the date is beyond the known horizon");
  if (bad.length) return bad;

  if (q.kind === "no_even_if_ready") return checkThresholdRefusal(withReadyDay(facts, q.makerId, 0), request, q.refusal, now, "ready on the first day");
  if (!Number.isInteger(q.lastDay) || q.lastDay < 0 || q.lastDay > v.H - 1) return ["threshold day outside the horizon"];
  const yes = withReadyDay(facts, q.makerId, q.lastDay);
  bad.push(...checkPlan(yes, request, q.plan, now).map((b) => `ready on day ${q.lastDay}: ${b}`));
  if (request.budgetUsdCents !== null && q.plan.money.priceUsdCents > request.budgetUsdCents) bad.push(`ready on day ${q.lastDay}: plan is over budget`);
  bad.push(...checkThresholdRefusal(withReadyDay(facts, q.makerId, q.lastDay + 1), request, q.refusal, now, `ready on day ${q.lastDay + 1}`));
  return bad;
}
