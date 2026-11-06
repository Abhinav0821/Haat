/**
 * Checker-owned runtime validation. Deliberately does not import the solver's
 * schema, graph, derivation or pricing code. Limits implement docs/planner-model.md.
 */
class Inspect {
  bad: string[] = [];
  object(x: unknown, path: string): Record<string, unknown> {
    if (!x || typeof x !== "object" || Array.isArray(x)) { this.bad.push(`${path}: expected an object`); return {}; }
    return x as Record<string, unknown>;
  }
  array(x: unknown, path: string, max: number): unknown[] {
    if (!Array.isArray(x) || x.length > max) { this.bad.push(`${path}: invalid array or exceeds ${max} entries`); return []; }
    return Array.from(x); // holes must be inspected as missing values, not skipped
  }
  number(x: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER, integer = false) {
    if (typeof x !== "number" || !Number.isFinite(x) || x < min || x > max || (integer && !Number.isSafeInteger(x))) this.bad.push(`${path}: invalid numeric value`);
  }
  text(x: unknown, path: string, max = 200) {
    if (typeof x !== "string" || !x.length || x.length > max) this.bad.push(`${path}: invalid text`);
  }
  bool(x: unknown, path: string) { if (typeof x !== "boolean") this.bad.push(`${path}: expected a boolean`); }
  amount(x: unknown, path: string) {
    this.number(x, path, 0, 1_000_000);
    if (typeof x === "number" && Math.abs(x * 100 - Math.round(x * 100)) >= 0.000001) this.bad.push(`${path}: use at most two decimal places`);
  }
  sourced(x: unknown, path: string, now: Date, check: (value: unknown, path: string) => void) {
    const o = this.object(x, path), p = this.object(o.prov, `${path}.prov`);
    if (!["maker_confirmed", "coordinator_entered", "buyer_stated", "system"].includes(String(p.source))) this.bad.push(`${path}: invalid provenance source`);
    if (p.by !== undefined && (typeof p.by !== "string" || p.by.length > 200)) this.bad.push(`${path}: invalid author`);
    const t = typeof p.at === "string" ? Date.parse(p.at) : NaN;
    if (typeof p.at !== "string" || p.at.length > 60 || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(p.at) || !validDate(p.at.slice(0, 10)) || !Number.isFinite(t) || t > now.getTime()) this.bad.push(`${path}: invalid or future confirmation time`);
    check(o.value, `${path}.value`);
  }
}
function validDate(s: unknown): boolean {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(s + "T00:00:00Z");
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

export function checkInputs(facts: unknown, request: unknown, now: Date): string[] {
  const i = new Inspect(), f = i.object(facts, "facts"), r = i.object(request, "request");
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return ["invalid planning time"];
  const count = (x: unknown, p: string) => i.number(x, p, 0, 1_000_000, true);
  const days = (x: unknown, p: string) => i.number(x, p, 0, 366, true);
  const amount = (x: unknown, p: string) => i.amount(x, p);
  const capacity = (x: unknown, p: string) => i.array(x, p, 366).forEach((n, t) => i.number(n, `${p}[${t}]`, 0, 10_000, true));
  const sourced = (x: unknown, p: string, check: (v: unknown, p: string) => void) => i.sourced(x, p, now, check);
  if (!validDate(f.startDate)) i.bad.push("invalid start date");
  i.number(f.horizonDays, "horizonDays", 1, 366, true);
  const H = typeof f.horizonDays === "number" ? f.horizonDays : 0;
  sourced(f.finishingPerDay, "finishingPerDay", (x, p) => { capacity(x, p); if (Array.isArray(x) && x.length !== H) i.bad.push("finishing capacity length ≠ horizon"); });
  days(f.lagDays, "lagDays"); days(f.packDays, "packDays"); days(f.staleAfterDays, "staleAfterDays");
  sourced(f.transitDays, "transitDays", days);
  sourced(f.inrPerUsd, "inrPerUsd", (x, p) => i.number(x, p, 0.01, 10_000));
  const c = i.object(f.costs, "costs");
  for (const key of ["finishingInrPerPiece", "packagingInrPerPiece", "collectionInrPerPiece", "chargeInrPerPiece", "shippingInrPerOrder"]) amount(c[key], `costs.${key}`);
  const fee = i.object(f.fee, "fee");
  i.number(fee.percent, "fee.percent", 0, 20); count(fee.fixedUsdCents, "fee.fixedUsdCents");
  const ids = new Set<string>();
  i.array(f.makers, "makers", 50).forEach((x, n) => {
    const m = i.object(x, `makers[${n}]`), p = `makers[${n}]`;
    i.text(m.id, `${p}.id`); i.text(m.name, `${p}.name`);
    if (typeof m.id === "string") { if (ids.has(m.id)) i.bad.push("duplicate maker ID"); ids.add(m.id); }
    sourced(m.capable, `${p}.capable`, (v, q) => i.bool(v, q));
    sourced(m.dailyCapacity, `${p}.dailyCapacity`, capacity);
    if (m.materialsReadyDay !== null) sourced(m.materialsReadyDay, `${p}.materialsReadyDay`, (v, q) => i.number(v, q, 0, 3650, true));
    sourced(m.askInrPerPiece, `${p}.askInrPerPiece`, amount);
    sourced(m.floorInrPerPiece, `${p}.floorInrPerPiece`, amount);
    if (m.maxPieces !== null) sourced(m.maxPieces, `${p}.maxPieces`, count);
    amount(m.fixedCostInr, `${p}.fixedCostInr`);
    sourced(m.commitments, `${p}.commitments`, (v, q) => i.array(v, q, 1000).forEach((entry, k) => {
      const d = i.object(entry, `${q}[${k}]`);
      i.text(d.ref, `${q}.ref`); i.number(d.pieces, `${q}.pieces`, 1, 1_000_000, true);
      if (d.dueDay !== null) i.number(d.dueDay, `${q}.dueDay`, 0, 3650, true);
    }));
  });
  const reservations = new Set<string>();
  let entries = 0;
  i.array(f.reservations, "reservations", 1000).forEach((x, n) => {
    const r = i.object(x, `reservations[${n}]`);
    i.text(r.planId, "reservation plan ID");
    if (typeof r.planId === "string") { if (reservations.has(r.planId)) i.bad.push("duplicate reservation ID"); reservations.add(r.planId); }
    for (const key of ["production", "finishing"]) {
      const a = i.array(r[key], `reservation.${key}`, key === "production" ? 20_000 : 366);
      entries += a.length;
      a.forEach((v) => {
        const e = i.object(v, `reservation.${key} entry`);
        i.number(e.day, "reservation day", 0, H - 1, true); i.number(e.pieces, "reserved pieces", 1, 1_000_000, true);
        if (key === "production" && (typeof e.makerId !== "string" || !ids.has(e.makerId))) i.bad.push("reservation refers to an unknown maker");
      });
    }
  });
  if (entries > 20_000) i.bad.push("too many reservation entries");
  i.number(r.quantity, "request.quantity", 1, 1_000_000, true);
  i.number(r.deliveryDay, "request.deliveryDay", 0, 3650, true);
  if (r.budgetUsdCents !== null) i.number(r.budgetUsdCents, "request.budgetUsdCents", 0, Number.MAX_SAFE_INTEGER, true);
  return i.bad;
}

function inspectPlan(i: Inspect, x: unknown) {
  const p = i.object(x, "plan");
  if (p.model !== "m1") i.bad.push("unsupported plan model");
  if (typeof p.factsHash !== "string" || !/^[a-f0-9]{64}$/.test(p.factsHash)) i.bad.push("invalid facts hash (different facts)");
  i.number(p.quantity, "plan.quantity", 1, 1_000_000, true); i.number(p.deliveryDay, "plan.deliveryDay", 0, 3650, true);
  i.number(p.lastFinishDay, "plan.lastFinishDay", -733, 3650, true);
  for (const key of ["production", "finishing"]) i.array(p[key], key, 20_000).forEach((v) => {
    const e = i.object(v, key);
    if (key === "production") i.text(e.makerId, "makerId");
    i.number(e.day, `${key}.day`, 0, 365, true); i.number(e.pieces, `${key}.pieces`, 1, 1_000_000, true);
  });
  const money = i.object(p.money, "money");
  i.array(money.perMaker, "pay lines", 50).forEach((v) => {
    const e = i.object(v, "pay line"); i.text(e.makerId, "pay maker ID");
    i.number(e.pieces, "pay pieces", 1, 1_000_000, true); i.number(e.payInr, "pay amount");
  });
  for (const k of ["makersInr", "finishingInr", "packagingInr", "collectionInr", "chargeInr", "shippingInr", "totalCostInr"]) i.number(money[k], `money.${k}`);
  for (const k of ["priceUsdCents", "estFeeUsdCents"]) i.number(money[k], `money.${k}`, 0, Number.MAX_SAFE_INTEGER, true);
}
function inspectCut(i: Inspect, x: unknown) {
  const c = i.object(x, "cut");
  i.number(c.lastFinishDay, "cut last day", -734, 3650, true); i.number(c.tau, "cut tau", 0, 366, true);
  i.number(c.bound, "cut bound", 0, Number.MAX_SAFE_INTEGER, true);
  i.array(c.makers, "cut makers", 50).forEach((v) => {
    const m = i.object(v, "cut maker"); i.text(m.makerId, "cut maker ID");
    if (m.u !== "cap") i.number(m.u, "cut u", 0, 366, true);
  });
}
function inspectOptimality(i: Inspect, x: unknown) {
  const c = i.object(x, "optimality");
  i.array(c.levels, "price levels", 50).forEach((v) => {
    const l = i.object(v, "price level"); i.amount(l.askInr, "ask price");
    i.array(l.makerIds, "price-level makers", 50).forEach((id) => i.text(id, "maker ID"));
    if (l.cut !== null) inspectCut(i, l.cut);
  });
}
export function planShape(x: unknown): string[] { const i = new Inspect(); inspectPlan(i, x); return i.bad; }
export function cutShape(x: unknown): string[] { const i = new Inspect(); inspectCut(i, x); return i.bad; }
export function optimalityShape(x: unknown): string[] { const i = new Inspect(); inspectOptimality(i, x); return i.bad; }

export function evaluationShape(x: unknown): string[] {
  const i = new Inspect(), e = i.object(x, "evaluation");
  const plan = (p: Record<string, unknown>) => { inspectPlan(i, p.plan); inspectOptimality(i, p.optimality); i.bool(p.certified, "certified"); };
  if (e.kind === "unresolved") {
    const issues = i.array(e.issues, "issues", 20_000);
    if (!issues.length) i.bad.push("unresolved without saying what is missing");
    issues.forEach((x) => {
      const p = i.object(x, "issue");
      if (!["missing", "stale", "inconsistent", "unsupported", "excluded", "estimate", "beyond_horizon", "error"].includes(String(p.code))) i.bad.push("unknown issue code");
      for (const key of ["fact", "en", "hi"]) i.text(p[key], `issue.${key}`, 10_000);
    });
    if (e.partial !== undefined) i.number(i.object(e.partial, "partial").maxQuantity, "partial quantity", 0, Number.MAX_SAFE_INTEGER, true);
    return i.bad;
  }
  if (e.kind === "feasible" || e.kind === "infeasible_budget") plan(e);
  else if (e.kind === "infeasible_capacity") {
    inspectCut(i, e.cut); i.number(e.requested, "requested", 1, 1_000_000, true); i.number(e.maxQuantity, "maxQuantity", 0, 1_000_000, true);
  } else i.bad.push("unknown evaluation kind");
  if (e.kind === "infeasible_budget") i.number(e.budgetUsdCents, "budget", 0, Number.MAX_SAFE_INTEGER, true);
  if (e.kind === "infeasible_capacity" || e.kind === "infeasible_budget") {
    const a = i.object(e.alternatives, "alternatives");
    if (a.largestByDate !== undefined) {
      const b = i.object(a.largestByDate, "largest by date");
      i.number(b.quantity, "largest quantity", 0, 1_000_000, true); inspectCut(i, b.cut); i.bool(b.certified, "certified");
      if (b.plan !== null) inspectPlan(i, b.plan);
      if (b.optimality !== null) inspectOptimality(i, b.optimality);
    }
    if (a.earliestDelivery !== undefined) {
      const d = i.object(a.earliestDelivery, "earliest delivery");
      if (d.kind === "found") { plan(d); if (d.dayBeforeCut !== null) inspectCut(i, d.dayBeforeCut); }
      else if (d.kind === "not_within_horizon") { inspectCut(i, d.cut); i.number(d.horizonDays, "horizonDays", 1, 366, true); }
      else i.bad.push("unknown earliest-delivery kind");
    }
    if (a.largestWithinBudget !== undefined) {
      const b = i.object(a.largestWithinBudget, "budget alternative"); i.number(b.quantity, "budget alternative quantity", 0, 1_000_000, true);
      if (b.quantity !== 0 || "plan" in b || "optimality" in b || "certified" in b) plan(b);
      const n = i.object(b.next, "next quantity proof"); inspectPlan(i, n.plan); inspectOptimality(i, n.optimality);
    }
  }
  return i.bad;
}
