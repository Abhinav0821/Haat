import { test } from "node:test";
import assert from "node:assert/strict";
import { EconomicsSchema } from "@/lib/economics";
import { capacityProof } from "@/lib/custom/capacity-proof";
import { completionDate, deliveryEstimate, isoDate, maxQuantityByDeadline } from "@/lib/custom/quote";
import { adviceFor } from "@/lib/custom/requests";

const now = new Date("2026-11-06T09:00:00Z");
const rules = (o: Partial<{ piecesPerWeek: number; backlogPieces: number; shippingDays: number }>) =>
  EconomicsSchema.parse({ materialsInr: 350, packagingInr: 50, shippingCostInr: 1200, shippingChargeUsdCents: 1500, minimumInr: 1500, piecesPerWeek: 4, backlogPieces: 6, shippingDays: 10, ...o });

test("single maker: the verified planner reproduces today's dates and capacity across 560 cases", () => {
  let n = 0,
    beyond = 0;
  const diffs: string[] = [];
  for (const ppw of [1, 2, 3, 4, 5, 6, 7])
    for (const backlog of [0, 4, 9, 20])
      for (const ship of [5, 10])
        for (const q of [1, 7, 12, 30, 60])
          for (const offset of [20, 45]) {
            const e = rules({ piecesPerWeek: ppw, backlogPieces: backlog, shippingDays: ship });
            const deadline = isoDate(new Date(Date.UTC(2026, 10, 6 + offset)));
            const p = capacityProof(e, q, deadline, now, 88);
            assert.equal(p.verified, true, `ppw ${ppw} backlog ${backlog} q ${q}: ${!p.verified && p.reason}`);
            if (!p.verified) continue;
            const done = completionDate(now, backlog, q, ppw);
            const workDays = Math.ceil(((backlog + q) * 7) / ppw);
            if (workDays > 366) {
              // Beyond the planner's one-year horizon it says "not within the horizon", never a date; advice uses the formula.
              assert.equal(p.earliest, null, `beyond horizon ${ppw}/${backlog}/${q}`);
              beyond++;
            } else if (p.earliest?.readyBy !== isoDate(done)) diffs.push(`ready ${ppw}/${backlog}/${q}: planner ${p.earliest?.readyBy} vs formula ${isoDate(done)}`);
            else assert.equal(p.earliest.delivery, isoDate(deliveryEstimate(done, ship)));
            const max = maxQuantityByDeadline(now, new Date(deadline), backlog, ppw, ship);
            assert.equal(p.byDeadline!.fits, max >= q, `fits ${ppw}/${backlog}/${q}/${offset}`);
            if (!p.byDeadline!.fits) assert.equal(p.byDeadline!.max, max);
            n++;
          }
  assert.equal(n, 560);
  assert.deepEqual(diffs, [], "identical ready dates within the horizon");
  assert.equal(beyond, 16, "60 pieces at 1/week lie beyond a year: reported as such, not dated");
});

test("advice explains a refusal in her terms, independently checked", () => {
  const advice = adviceFor({ quantity: 12, item: "scarf", colors: [], materials: [], deadline: "2026-12-10", budgetUsdCents: null }, rules({}), now, 88);
  const en = advice.en.join("\n");
  assert.match(en, /12 pieces can be ready 2026-12-08; estimated delivery 2026-12-18/);
  assert.match(en, /At most 7 pieces can arrive by the buyer's date: at your pace you can make 13 by 2026-11-29 .* and 6 are already promised\. Independently checked\./);
  assert.equal(advice.hi.length, advice.en.length, "every Hindi line has its English line");
  assert.match(advice.hi.join(" "), /ज़्यादा से ज़्यादा 7 पीस/);
});

test("when the planner can't verify (work booked beyond a year), advice falls back to today's formulas", () => {
  const e = rules({ piecesPerWeek: 1, backlogPieces: 80 });
  const p = capacityProof(e, 5, "2026-12-10", now, 88);
  assert.equal(p.verified, false);
  const advice = adviceFor({ quantity: 5, item: "scarf", colors: [], materials: [], deadline: "2026-12-10", budgetUsdCents: null }, e, now, 88);
  assert.match(advice.en.join("\n"), /At most 0 pieces can arrive by the buyer's date\.$/m);
  assert.doesNotMatch(advice.en.join("\n"), /Independently checked/);
});

test("no capacity set: no proof, and the advice is unchanged", () => {
  const e = EconomicsSchema.parse({ materialsInr: 350, packagingInr: 50, shippingCostInr: 1200, minimumInr: 1500, piecesPerWeek: null });
  assert.equal(capacityProof(e, 5, null, now, 88).verified, false);
  const advice = adviceFor({ quantity: 5, item: "scarf", colors: [], materials: [], deadline: null, budgetUsdCents: null }, e, now, 88);
  assert.ok(advice.en.every((l) => !/ready/.test(l)));
});

test("the planner and the fixed formula agree where floating point used to round up a day", () => {
  for (const [backlog, q] of [[0, 29], [17, 12], [29, 29], [0, 58]]) {
    const p = capacityProof(rules({ piecesPerWeek: 7, backlogPieces: backlog }), q, null, now, 88);
    assert.ok(p.verified && p.earliest);
    if (p.verified) assert.equal(p.earliest!.readyBy, isoDate(completionDate(now, backlog, q, 7)), `${backlog}+${q} at 7/week`);
  }
});
