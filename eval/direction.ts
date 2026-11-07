import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { evaluate } from "@/lib/planner/solve";
import { checkEvaluation, checkQuestion } from "@/lib/planner/check";
import { decidingQuestion } from "@/lib/planner/question";
import { aloneVsTogether } from "@/lib/collective/compare";
import { keepAgreedOption, keptBy, type AcceptedPart } from "@/lib/collective/replan";
import { hashOf, partTerms } from "@/lib/collective/terms";
import type { CollectiveFacts, Plan } from "@/lib/planner/model";
import { handcrafted, NOW, randomScenarios, START, type Scenario } from "./scenarios";
import { QUOTA } from "./run";

/**
 * Measures for docs/direction.md §B–§D on the SAME 46 cases as the M1 evaluation.
 * Deterministic, no model calls. Reported separately from the M1 results: §C is the
 * documented extension M1-Q1, and §D's "most parts kept" is an exhaustive search, not a
 * certificate.
 *
 *  B. Alone vs together — of the checked "yes" cases, how many no single maker could take.
 *  C. One unknown date — of the "undecided" cases, how many M1-Q1 decides with a checked
 *     question, and how many facts the coordinator would otherwise be asked to chase.
 *  D. Keeping agreed parts — on every "yes" case, a perturbation (one producing maker
 *     drops out; or loses her first three working days): makers asked again by the
 *     cheapest fresh plan vs by the plan that keeps agreed parts, and the price premium.
 */

const CTX = { collective: "Eval collective", orderRef: "eval0000", product: { en: "scarf", hi: "दुपट्टा" }, details: null, detailsHi: null, transitDays: 7 };

function partsOf(plan: Plan, f: CollectiveFacts): AcceptedPart[] {
  return [...new Set(plan.production.map((p) => p.makerId))].sort().map((id) => {
    const t = partTerms(plan, START, id, CTX)!;
    return { memberId: id, name: f.makers.find((m) => m.id === id)?.name ?? id, termsHash: hashOf(t), schedule: t.schedule };
  });
}

type Perturb = { label: string; apply: (f: CollectiveFacts, plan: Plan) => CollectiveFacts | null };
const PERTURBATIONS: Perturb[] = [
  {
    label: "a producing maker drops out",
    apply: (f, plan) => {
      const id = [...new Set(plan.production.map((p) => p.makerId))].sort()[0];
      return { ...f, makers: f.makers.map((m) => (m.id === id ? { ...m, capable: { ...m.capable, value: false } } : m)) };
    },
  },
  {
    label: "a producing maker loses her first three working days in the plan",
    apply: (f, plan) => {
      const id = [...new Set(plan.production.map((p) => p.makerId))].sort()[0];
      const days = [...new Set(plan.production.filter((p) => p.makerId === id).map((p) => p.day))].sort((a, b) => a - b).slice(0, 3);
      return { ...f, makers: f.makers.map((m) => (m.id === id ? { ...m, dailyCapacity: { ...m.dailyCapacity, value: m.dailyCapacity.value.map((x, t) => (days.includes(t) ? 0 : x)) } } : m)) };
    },
  },
];

export function measure(seed = 20261108) {
  const scenarios: Scenario[] = [...handcrafted(), ...randomScenarios(seed, QUOTA)];
  const B = { yesCases: 0, noneAloneButTogether: 0, someoneAlone: 0, aloneUndecided: 0 };
  const C = { undecided: 0, threshold: 0, noEvenIfReady: 0, notApplicable: 0, checked: 0, factsListed: 0, factsListedWhenDecided: 0 };
  const D = PERTURBATIONS.map((p) => ({ label: p.label, cases: 0, replanFeasible: 0, keepFound: 0, keepBeatsFresh: 0, freshAsked: 0, keepAsked: 0, freshKept: 0, keepKept: 0, premiums: [] as number[], checked: 0 }));

  for (const s of scenarios) {
    const ev = evaluate(s.facts, s.request, NOW);
    const problems = ev.kind === "unresolved" ? [] : checkEvaluation(s.facts, s.request, ev, NOW);
    if (s.truth === "yes" && ev.kind === "feasible" && problems.length === 0) {
      B.yesCases++;
      const c = aloneVsTogether(s.facts, s.request, NOW, { evaluation: ev, problems });
      if (c.noneAloneButTogether) B.noneAloneButTogether++;
      else if (c.alone.some((a) => a.kind === "feasible")) B.someoneAlone++;
      else B.aloneUndecided++;

      const accepted = partsOf(ev.plan, s.facts);
      PERTURBATIONS.forEach((p, i) => {
        const f2 = p.apply(s.facts, ev.plan);
        if (!f2) return;
        const d = D[i];
        d.cases++;
        const ev2 = evaluate(f2, s.request, NOW);
        if (ev2.kind !== "feasible" || checkEvaluation(f2, s.request, ev2, NOW).length) return;
        d.replanFeasible++;
        const producingFresh = new Set(ev2.plan.production.map((x) => x.makerId)).size;
        const freshKept = keptBy(ev2.plan, START, accepted, CTX).length;
        const freshAsked = producingFresh - freshKept;
        d.freshKept += freshKept;
        const { option } = keepAgreedOption(f2, s.request, NOW, accepted, CTX, ev2.plan);
        d.freshAsked += freshAsked;
        if (!option) {
          d.keepAsked += freshAsked; // no agreed part can be kept: the coordinator sends the fresh plan
          d.keepKept += freshKept;
          return;
        }
        d.keepKept += option.kept.length;
        d.keepFound++;
        d.checked++;
        d.keepAsked += option.askedAgain.length;
        if (option.askedAgain.length < freshAsked) d.keepBeatsFresh++;
        d.premiums.push(option.premiumUsdCents ?? 0);
      });
    }
    if (s.truth === "undecided" && ev.kind === "unresolved") {
      C.undecided++;
      const listed = ev.issues.filter((x) => x.code !== "excluded" && x.code !== "estimate").length;
      C.factsListed += listed;
      const q = decidingQuestion(s.facts, s.request, NOW, ev);
      if (!q) C.notApplicable++;
      else {
        if (q.kind === "threshold") C.threshold++;
        else C.noEvenIfReady++;
        if (checkQuestion(s.facts, s.request, q, NOW).length === 0) C.checked++;
        C.factsListedWhenDecided += listed;
      }
    }
  }
  return { seed, cases: scenarios.length, B, C, D };
}

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] : 0);

export function report(m: ReturnType<typeof measure>): string {
  const { B, C, D } = m;
  const lines = [
    `# Direction measures — seed ${m.seed}`,
    "",
    `The same ${m.cases} synthetic cases as the M1 evaluation ([seed-${m.seed}.md](seed-${m.seed}.md)). Deterministic; no model calls. Reported separately: §C is extension M1-Q1, and §D's "most parts kept" comes from exhaustive search, not a certificate. Synthetic cases show what the method does on the model; they are not evidence about real collectives.`,
    "",
    "## B. Alone vs together",
    "",
    `Of ${B.yesCases} checked "yes" cases:`,
    "",
    `| | Cases |`,
    `|---|---|`,
    `| No single maker could take it; the group could (both checked) | ${B.noneAloneButTogether} |`,
    `| At least one maker could take it alone | ${B.someoneAlone} |`,
    `| A standalone answer was undecided (no claim made) | ${B.aloneUndecided} |`,
    "",
    "## C. One unknown materials date (M1-Q1)",
    "",
    `Of ${C.undecided} "undecided" cases:`,
    "",
    `| | Cases |`,
    `|---|---|`,
    `| Threshold date found ("ready by D works; from D+1 it doesn't") | ${C.threshold} |`,
    `| No even if her materials were ready on the first day | ${C.noEvenIfReady} |`,
    `| Out of scope (several unknowns, or other incomplete facts): the list of facts stays | ${C.notApplicable} |`,
    `| Of the decided ones, passing the independent checker | ${C.checked}/${C.threshold + C.noEvenIfReady} |`,
    "",
    `In these ${C.threshold + C.noEvenIfReady} cases M1 lists ${C.factsListedWhenDecided} open issue(s) — her date, sometimes with a minimum-price note — and stays undecided. M1-Q1 does not reduce how many facts are asked for; it adds which dates would work, or a checked "no" whatever her date.`,
    "",
    "## D. Keeping agreed parts after a change",
    "",
    'Every checked "yes" case, with every maker having accepted her part, then one change. "Asked again" counts producing makers whose part is new or changed.',
    "",
    "| Change | Cases | Re-plan possible | Agreed parts kept: fresh / keep-plan | Makers asked again: fresh / keep-plan | Cases with fewer asked | Premium when a keep-plan exists (median / max) |",
    "|---|---|---|---|---|---|---|",
    ...D.map((d) => `| ${d.label} | ${d.cases} | ${d.replanFeasible} | ${d.freshKept} / ${d.keepKept} | ${d.freshAsked} / ${d.keepAsked} | ${d.keepBeatsFresh} | ${usd(median(d.premiums))} / ${usd(d.premiums.length ? Math.max(...d.premiums) : 0)} |`),
    "",
    "A keep-plan can keep more agreed parts without asking fewer makers (it may bring in another maker for the shortfall). The premium is against the cheapest fresh plan; it is the price of keeping those agreements.",
    "",
    "Kept parts are verified identical by terms hash, and every keep-plan passes the independent checker. That no larger set of parts could be kept is established by exhaustive search (at most 8 accepted parts), not by a certificate.",
    "",
  ];
  return lines.join("\n");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const m = measure();
  const dir = path.join(process.cwd(), "eval", "results");
  fs.writeFileSync(path.join(dir, `direction-seed-${m.seed}.json`), JSON.stringify(m, null, 1));
  fs.writeFileSync(path.join(dir, `direction-seed-${m.seed}.md`), report(m));
  console.log(report(m));
}
