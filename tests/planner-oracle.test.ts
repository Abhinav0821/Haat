import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "@/lib/planner/solve";
import { checkEvaluation } from "@/lib/planner/check";
import type { CollectiveFacts, Commitment } from "@/lib/planner/model";
import { NOW, collective, maker, rng } from "./planner-helpers";

/**
 * Exhaustive reference: on small instances, enumerate EVERY per-maker, per-day production
 * vector, simulate finishing (earliest-first is optimal for one shared stage of identical
 * pieces), and check promises with the deadline-prefix condition. This shares no code with
 * the flow solver. The solver's maximum and minimum cost must match exactly, and the
 * independent checker must accept every answer.
 */

type Small = { H: number; lag: number; L: number; fin: number[]; makers: { cap: number[]; ready: number; ask: number; commits: Commitment[]; max: number | null }[] };

function generate(r: () => number): Small {
  const H = 4 + Math.floor(r() * 3); // 4–6 days
  const M = r() < 0.15 ? 1 : 2 + Math.floor(r() * 2); // mostly 2–3 makers
  const lag = Math.floor(r() * 2);
  const asks = [800, 900, 900, 1000, 1200];
  return {
    H,
    lag,
    L: H - 1 - Math.floor(r() * 2),
    fin: Array.from({ length: H }, () => Math.floor(r() * 4)),
    makers: Array.from({ length: M }, () => {
      const cap = Array.from({ length: H }, () => Math.floor(r() * 3));
      const commits: Commitment[] = r() < 0.4 ? [{ ref: "c", pieces: 1 + Math.floor(r() * 2), dueDay: r() < 0.3 ? null : Math.floor(r() * H) }] : [];
      return { cap, ready: Math.floor(r() * 2), ask: asks[Math.floor(r() * asks.length)], commits, max: r() < 0.25 ? 1 + Math.floor(r() * 3) : null };
    }),
  };
}

function toFacts(s: Small): CollectiveFacts {
  return collective({
    H: s.H,
    fin: s.fin,
    lag: s.lag,
    transit: 0,
    pack: 0,
    makers: s.makers.map((m, i) => maker(`m${i}`, { cap: m.cap, ready: m.ready, ask: m.ask, floor: 500, commits: m.commits, max: m.max })),
  });
}

/** Due days for undated promises: first-in-first-out on her earliest capacity (docs §1). */
function dues(cap: number[], commits: Commitment[]): { pieces: number; due: number }[] | null {
  let undated = 0;
  const out: { pieces: number; due: number }[] = [];
  for (const c of commits) {
    if (c.dueDay !== null) out.push({ pieces: c.pieces, due: c.dueDay });
    else {
      undated += c.pieces;
      let run = 0;
      const t = cap.findIndex((x) => (run += x) >= undated);
      if (t < 0) return null;
      out.push({ pieces: c.pieces, due: t });
    }
  }
  return out;
}
const fits = (left: number[], ds: { pieces: number; due: number }[]) =>
  ds.every((d) => left.slice(0, d.due + 1).reduce((a, b) => a + b, 0) >= ds.filter((x) => x.due <= d.due).reduce((a, b) => a + b.pieces, 0));

/** Returns max finishable quantity and min maker cost for every quantity, or null if the instance is ill-formed (promises don't fit). */
function bruteForce(s: Small): { max: number; minCost: Map<number, number> } | null {
  const ds = s.makers.map((m) => dues(m.cap, m.commits));
  if (ds.some((d) => d === null || !fits(s.makers[ds.indexOf(d)].cap, d))) return null;
  const cells: { m: number; t: number; hi: number }[] = [];
  s.makers.forEach((m, i) => m.cap.forEach((c, t) => t >= m.ready && t + s.lag <= s.L && c > 0 && cells.push({ m: i, t, hi: c })));
  const prod = s.makers.map(() => new Array(s.H).fill(0));
  let max = 0;
  const minCost = new Map<number, number>();
  const visit = (k: number) => {
    if (k === cells.length) {
      for (let i = 0; i < s.makers.length; i++) {
        const m = s.makers[i];
        const total = prod[i].reduce((a: number, b: number) => a + b, 0);
        if (m.max !== null && total > m.max) return;
        if (!fits(m.cap.map((c, t) => c - prod[i][t]), ds[i]!)) return;
      }
      let pool = 0;
      let done = 0;
      for (let t = 0; t <= s.L; t++) {
        if (t - s.lag >= 0) for (let i = 0; i < s.makers.length; i++) pool += prod[i][t - s.lag];
        const f = Math.min(pool, s.fin[t]);
        pool -= f;
        done += f;
      }
      const produced = prod.flat().reduce((a, b) => a + b, 0);
      max = Math.max(max, done);
      if (produced === done && produced > 0) {
        const cost = prod.reduce((a, row, i) => a + row.reduce((x: number, y: number) => x + y, 0) * s.makers[i].ask, 0);
        if (!minCost.has(produced) || cost < minCost.get(produced)!) minCost.set(produced, cost);
      }
      return;
    }
    const c = cells[k];
    for (let v = 0; v <= c.hi; v++) {
      prod[c.m][c.t] = v;
      visit(k + 1);
    }
    prod[c.m][c.t] = 0;
  };
  visit(0);
  return { max, minCost };
}

test("exhaustive reference: maximum quantity, minimum cost, refusals and certificates agree on 300 random instances", () => {
  const r = rng(20261106);
  let instances = 0,
    answers = 0,
    refusals = 0,
    uncertified = 0;
  const seen = { maxAtLeast4: 0, multiMakerPlans: 0, withPromises: 0, withLimits: 0, withLag: 0, cutUsesMakerDays: 0, cutUsesCap: 0, finishingBinds: 0 };
  while (instances < 300) {
    const s = generate(r);
    const space = s.makers.reduce((a, m) => a * m.cap.reduce((x, c) => x * (c + 1), 1), 1);
    if (space > 200_000) continue;
    const truth = bruteForce(s);
    if (!truth) continue;
    instances++;
    if (truth.max >= 4) seen.maxAtLeast4++;
    if (s.makers.some((m) => m.commits.length)) seen.withPromises++;
    if (s.makers.some((m) => m.max !== null)) seen.withLimits++;
    if (s.lag > 0) seen.withLag++;
    const facts = toFacts(s);
    const deliveryDay = s.L + 1;
    for (let Q = 1; Q <= truth.max + 1; Q++) {
      const req = { quantity: Q, deliveryDay, budgetUsdCents: null };
      const ev = evaluate(facts, req, NOW);
      const problems = checkEvaluation(facts, req, ev, NOW);
      assert.deepEqual(problems, [], `instance ${instances} Q=${Q}: ${JSON.stringify(s)}`);
      answers++;
      if (Q <= truth.max) {
        assert.equal(ev.kind, "feasible", `instance ${instances}: ${Q} ≤ max ${truth.max} must be feasible ${JSON.stringify(s)}`);
        if (ev.kind === "feasible") {
          assert.equal(ev.plan.money.makersInr, truth.minCost.get(Q), `instance ${instances} Q=${Q}: min cost ${JSON.stringify(s)}`);
          if (!ev.certified) uncertified++;
          if (ev.plan.money.perMaker.length > 1) seen.multiMakerPlans++;
        }
      } else {
        assert.equal(ev.kind, "infeasible_capacity", `instance ${instances}: ${Q} > max ${truth.max}`);
        if (ev.kind === "infeasible_capacity") {
          assert.equal(ev.maxQuantity, truth.max);
          if (ev.cut.makers.some((m) => m.u === "cap")) seen.cutUsesCap++;
          else if (ev.cut.makers.some((m) => m.u !== 0)) seen.cutUsesMakerDays++;
          else seen.finishingBinds++;
        }
        refusals++;
      }
    }
  }
  assert.equal(uncertified, 0, "every optimal plan carried a verifiable optimality certificate");
  console.log("oracle coverage", JSON.stringify(seen));
  console.log(`oracle: ${instances} instances, ${answers} answers (${refusals} certified refusals), all matched and verified`);
});
