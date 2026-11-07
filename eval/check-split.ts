/**
 * Check a coordinator's MANUAL split (from the role-play's manual round) with the same
 * independent checker the planner is held to, on the demo collective's facts.
 *
 *   npx tsx eval/check-split.ts split.json
 *
 * split.json:
 * {
 *   "madeOn": "2026-11-08",            // the session date (plans start the next day)
 *   "quantity": 60, "deliverBy": "2026-12-02",
 *   "production": [{ "maker": "Meera", "date": "2026-11-09", "pieces": 3 }, …],
 *   "finishing":  [{ "date": "2026-11-10", "pieces": 8 }, …]
 * }
 *
 * Uses the demo makers' facts as on the maker cards (docs/role-play-kit.md), confirmed,
 * with no other orders holding capacity: right for task 1 of the kit.
 */
import fs from "node:fs";
import { buildFacts, MemberFactsSchema } from "@/lib/collective/facts";
import { DEMO_MEMBERS, demoSettings } from "@/lib/collective/seed";
import { dayDate, dayIndex } from "@/lib/planner/model";
import { checkPlan } from "@/lib/planner/check";
import { evaluate } from "@/lib/planner/solve";
import { asPlan } from "./approaches";
import { categorise } from "./score";

const file = process.argv[2];
if (!file) {
  console.error("usage: npx tsx eval/check-split.ts split.json");
  process.exit(2);
}
const split = JSON.parse(fs.readFileSync(file, "utf8")) as {
  madeOn: string; quantity: number; deliverBy: string;
  production: { maker: string; date: string; pieces: number }[];
  finishing: { date: string; pieces: number }[];
};
const at = `${split.madeOn}T09:00:00Z`;
const now = new Date(at);
const start = dayDate(split.madeOn, 1);
const members = DEMO_MEMBERS.map((m) => ({ id: m.name, name: m.name, facts: MemberFactsSchema.parse({ ...m.facts, materialsReadyDate: dayDate(split.madeOn, m.facts.materialsDays ?? 0), prov: { source: "maker_confirmed", at } }) }));
const facts = buildFacts(demoSettings(at), members, [], start);
const request = { quantity: split.quantity, deliveryDay: dayIndex(start, split.deliverBy), budgetUsdCents: null };
const plan = asPlan(
  facts,
  request,
  split.production.map((p) => ({ makerId: p.maker, day: dayIndex(start, p.date), pieces: p.pieces })),
  split.finishing.map((f) => ({ day: dayIndex(start, f.date), pieces: f.pieces })),
);
const problems = checkPlan(facts, request, plan, now);
const ev = evaluate(facts, request, now);
console.log(problems.length ? `NOT VALID: ${categorise(problems).join(", ")}\n- ${problems.slice(0, 8).join("\n- ")}` : `VALID. Price $${(plan.money.priceUsdCents / 100).toFixed(2)}.`);
if (ev.kind === "feasible") console.log(`Cheapest possible for this request: $${(ev.plan.money.priceUsdCents / 100).toFixed(2)}.`);
else if (ev.kind === "infeasible_capacity") console.log(`The request can't be met: at most ${ev.maxQuantity} by that date.`);
