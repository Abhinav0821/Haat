import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createSnapshot, parseSnapshot } from "@/lib/planner/snapshot";
import { dayDate, dayIndex } from "@/lib/planner/model";
import { buildFacts, MemberFactsSchema } from "@/lib/collective/facts";
import { DEMO_MEMBERS, demoSettings } from "@/lib/collective/seed";
import { completeAnswerCorrect, onlyMaker, score } from "../eval/score";
import { asPlan } from "../eval/approaches";
import { assessManual, compareHaatInputs, scenarioSheet } from "../eval/manual";
import { handcrafted, truthOf, NOW } from "../eval/scenarios";

const s = handcrafted()[1];
const ev = truthOf(s.facts, s.request).ev;
if (ev.kind !== "feasible") throw new Error("fixture must fit");
const snapshot = createSnapshot(s.facts, s.request, NOW);
const answer = {
  scenarioFingerprint: snapshot.fingerprint, decision: "yes", priceUsdCents: ev.plan.money.priceUsdCents,
  production: ev.plan.production.map((p) => ({ maker: p.makerId, date: dayDate(s.facts.startDate, p.day), pieces: p.pieces })),
  finishing: ev.plan.finishing.map((f) => ({ date: dayDate(s.facts.startDate, f.day), pieces: f.pieces })),
};

test("a valid schedule with a one-cent or missing quote is never a completely correct answer", () => {
  for (const statedPriceUsdCents of [1, null]) {
    const result = score(s, ev, { kind: "yes", plan: ev.plan, statedPriceUsdCents });
    assert.equal(result.outcome, "correct_yes");
    assert.equal(completeAnswerCorrect(result), false);
  }
  const checked = assessManual(snapshot, { ...answer, priceUsdCents: 1 });
  assert.equal(checked.valid, false);
  assert.equal(checked.quotedPriceUsdCents, 1);
  assert.equal(checked.schedulePriceUsdCents, ev.plan.money.priceUsdCents);
  assert.equal(assessManual(snapshot, answer).valid, true);
  assert.throws(() => assessManual(snapshot, { ...answer, priceUsdCents: null }));
});

test("a valid but unnecessarily expensive allocation is not counted as a completely correct minimum-price answer", () => {
  const single = truthOf(onlyMaker(s.facts, "Rukhsana"), s.request).ev;
  if (single.kind !== "feasible") assert.fail("single maker fixture must fit");
  const plan = asPlan(s.facts, s.request, single.plan.production, single.plan.finishing);
  const result = score(s, ev, { kind: "yes", plan, statedPriceUsdCents: plan.money.priceUsdCents });
  assert.equal(result.outcome, "correct_yes");
  assert.equal(result.statedPriceRight, true);
  assert.ok(result.priceGap! > 0);
  assert.equal(completeAnswerCorrect(result), false);
});

test("manual answers are bound to a saved scenario, whose facts cannot be silently edited", () => {
  assert.deepEqual(parseSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot);
  const edited = structuredClone(snapshot); edited.facts.makers[0].askInrPerPiece.value++;
  assert.throws(() => parseSnapshot(edited), /inputs changed/);
  assert.throws(() => assessManual(snapshot, { ...answer, scenarioFingerprint: "0".repeat(64) }), /different scenario/);
  const changed = createSnapshot(edited.facts, s.request, NOW);
  assert.equal(compareHaatInputs(snapshot, changed), false);
  const evaluated = createSnapshot(s.facts, s.request, NOW, { orderId: "case", offeredFactsHash: null, evaluatedFactsHash: snapshot.factsFingerprint });
  assert.equal(compareHaatInputs(snapshot, evaluated), true);
  assert.equal(compareHaatInputs(snapshot, snapshot), false, "a live comparison needs an actual evaluation fingerprint");
});

test("the same competing-order split passes with empty reservations and fails with the actual first order held", () => {
  const madeOn = "2026-11-08", start = dayDate(madeOn, 1), at = new Date(`${madeOn}T09:00:00Z`);
  const members = DEMO_MEMBERS.map((m) => ({ id: m.name, name: m.name, facts: MemberFactsSchema.parse({ ...m.facts, materialsReadyDate: dayDate(madeOn, m.facts.materialsDays ?? 0), prov: { source: "maker_confirmed", at: at.toISOString() } }) }));
  const settings = demoSettings(at.toISOString());
  const fresh = buildFacts(settings, members, [], start);
  const firstRequest = { quantity: 60, deliveryDay: dayIndex(start, dayDate(madeOn, 24)), budgetUsdCents: null };
  const first = truthOf(fresh, firstRequest, at).ev;
  if (first.kind !== "feasible") assert.fail("first order must fit");
  const held = buildFacts(settings, members, [{ planId: "first", production: first.plan.production.map((p) => ({ memberId: p.makerId, date: dayDate(start, p.day), pieces: p.pieces })), finishing: first.plan.finishing.map((f) => ({ date: dayDate(start, f.day), pieces: f.pieces })) }], start);
  const request = { ...firstRequest, quantity: 50 }, second = truthOf(fresh, request, at).ev;
  if (second.kind !== "feasible") assert.fail("fresh scenario must fit");
  const reserved = createSnapshot(held, request, at), empty = createSnapshot(fresh, request, at);
  const split = { decision: "yes", priceUsdCents: second.plan.money.priceUsdCents, production: second.plan.production.map((p) => ({ maker: p.makerId, date: dayDate(start, p.day), pieces: p.pieces })), finishing: second.plan.finishing.map((f) => ({ date: dayDate(start, f.day), pieces: f.pieces })) };
  assert.equal(assessManual(empty, { ...split, scenarioFingerprint: empty.fingerprint }).valid, true);
  const rejected = assessManual(reserved, { ...split, scenarioFingerprint: reserved.fingerprint });
  assert.equal(rejected.valid, false);
  assert.match(rejected.score.violations.join(" "), /over capacity/);
  assert.equal(rejected.haat.kind, "infeasible_capacity");
  if (rejected.haat.kind === "infeasible_capacity") assert.equal(rejected.haat.maxQuantity, 14);
});

test("changed prices, excluded makers and the snapshot's own date are used for manual assessment", () => {
  const changed = structuredClone(s.facts);
  changed.makers[0].askInrPerPiece.value += 30;
  const later = new Date("2026-11-08T12:00:00Z");
  changed.makers[0].dailyCapacity.prov.at = later.toISOString();
  const revised = createSnapshot(changed, s.request, later);
  const repriced = assessManual(revised, { ...answer, scenarioFingerprint: revised.fingerprint });
  assert.equal(repriced.valid, false);
  assert.equal(repriced.score.outcome, "correct_yes", "the snapshot's timestamp permits its later confirmation");
  assert.equal(repriced.score.statedPriceRight, false);
  changed.makers[0].capable.value = false;
  const excluded = createSnapshot(changed, s.request, later);
  assert.equal(assessManual(excluded, { ...answer, scenarioFingerprint: excluded.fingerprint }).valid, false);
  const sheet = scenarioSheet(excluded);
  assert.match(sheet, /capable false/);
  assert.doesNotMatch(sheet, /minimum|floorInr/);
});

test("manual refusals and cannot-decide answers are scored, including their maximum or minimum-price claim", () => {
  for (const s of handcrafted().filter((s) => s.truth !== "yes")) {
    const snap = createSnapshot(s.facts, s.request, NOW), ev = truthOf(s.facts, s.request).ev;
    const answer = ev.kind === "infeasible_capacity" ? { decision: "no_capacity", maxQuantityByDate: ev.maxQuantity }
      : ev.kind === "infeasible_budget" ? { decision: "no_budget", priceUsdCents: ev.plan.money.priceUsdCents }
      : { decision: "cannot_decide", reason: "Need the missing facts" };
    assert.equal(assessManual(snap, { ...answer, scenarioFingerprint: snap.fingerprint }).valid, true);
    if (ev.kind === "infeasible_capacity") assert.equal(assessManual(snap, { ...answer, scenarioFingerprint: snap.fingerprint, maxQuantityByDate: ev.maxQuantity + 1 }).valid, false);
    if (ev.kind === "infeasible_budget") assert.equal(assessManual(snap, { ...answer, scenarioFingerprint: snap.fingerprint, priceUsdCents: 1 }).valid, false);
  }
});

test("the documented manual CLI reports valid, wrong-price and mismatched-input outcomes with distinct exit codes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haat-manual-cli-"));
  const scenario = path.join(dir, "scenario.json"), split = path.join(dir, "split.json"), after = path.join(dir, "after.json");
  fs.writeFileSync(scenario, JSON.stringify(snapshot));
  fs.writeFileSync(split, JSON.stringify(answer));
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "eval/check-split.ts", ...args], { cwd: process.cwd(), encoding: "utf8" });
  const valid = run(scenario, split);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).valid, true);
  fs.writeFileSync(split, JSON.stringify({ ...answer, priceUsdCents: 1 }));
  assert.equal(run(scenario, split).status, 1);
  fs.writeFileSync(split, JSON.stringify(answer));
  fs.writeFileSync(after, JSON.stringify(snapshot)); // no evidence of a live Haat evaluation
  assert.equal(run(scenario, split, "--compare", after).status, 2);
  const sheet = run(scenario, "--sheet");
  assert.equal(sheet.status, 0);
  assert.doesNotMatch(sheet.stdout, /Cheapest possible|"kind"|"plan"/);
});
