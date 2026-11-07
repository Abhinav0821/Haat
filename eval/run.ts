/**
 * Comparative evaluation (step 6). Same facts, same requests, four approaches,
 * one independent checker.
 *
 *   npm run eval                     # seed 20261108; the AI model answers the 18-case subset
 *   npm run eval -- --no-llm         # deterministic approaches only
 *   npm run eval -- --llm-all        # the AI model answers all 46 cases (about 3 free-tier days)
 *   npm run eval -- --seed 7
 *
 * The AI model's answers are saved one by one in eval/results/llm-cache-*.json, so a run
 * stopped by the daily quota resumes where it stopped. Set EVAL_GOOGLE_API_KEY (and
 * optionally EVAL_MODEL) to keep the app's own quota free.
 *
 * Writes eval/results/seed-<seed>.json (every case, answer, score, raw model output)
 * and eval/results/seed-<seed>.md (summary tables).
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import fs from "node:fs";
import path from "node:path";
import { handcrafted, randomScenarios, truthOf, type Scenario, type Truth } from "./scenarios";
import { oldHaat, planner, ruleBased, type Answer } from "./approaches";
import { askModel, PROMPT_VERSION, SYSTEM, toAnswer, type LlmRaw } from "./llm";
import { score, type Outcome, type Score } from "./score";

const args = process.argv.slice(2);
const seed = Number(args[args.indexOf("--seed") + 1] || 20261108) || 20261108;
const noLlm = args.includes("--no-llm");
const llmAll = args.includes("--llm-all");
const QUOTA: Record<Truth, number> = { yes: 16, no_capacity: 12, no_budget: 6, undecided: 6 };
/** The AI subset: every hand-written case + the first generated cases of each answer type. */
const SUBSET: Record<Truth, number> = { yes: 4, no_capacity: 3, no_budget: 2, undecided: 3 };
const APPROACHES = ["planner", "rule_based", "old_haat", "llm_direct"] as const;
type Approach = (typeof APPROACHES)[number];
const LABEL: Record<Approach, string> = {
  planner: "Planner (model M1)",
  rule_based: "Rule-based split",
  old_haat: "Old Haat (one maker)",
  llm_direct: "AI model, direct",
};

const outDir = path.join(process.cwd(), "eval", "results");
const outJson = path.join(outDir, `seed-${seed}.json`);
const modelId = process.env.EVAL_MODEL || process.env.GOOGLE_MODEL || "gemini-3.6-flash";
const apiKey = process.env.EVAL_GOOGLE_API_KEY || process.env.GOOGLE_API_KEY;
const cachePath = path.join(outDir, `llm-cache-seed-${seed}-${modelId}-${PROMPT_VERSION}.json`);

type LlmRecord = { raw: LlmRaw | null; error: string | null; attempts: number; ms: number; at?: string };
type Row = { id: string; label: string; truth: Truth; request: Scenario["request"]; makers: number; inSubset: boolean; answers: Record<Approach, { answer: Answer | null; score: Score | null }>; llm?: LlmRecord };

const summariseAnswer = (a: Answer | null) => {
  if (!a) return null;
  if (a.kind === "yes") return { kind: a.kind, quantity: a.plan.quantity, priceUsdCents: a.plan.money.priceUsdCents, statedPriceUsdCents: a.statedPriceUsdCents ?? null, production: a.plan.production, finishing: a.plan.finishing };
  return a;
};

export function subsetIds(scenarios: Scenario[]): Set<string> {
  const left = { ...SUBSET };
  const ids = new Set<string>();
  for (const s of scenarios) {
    if (s.id.startsWith("h")) ids.add(s.id);
    else if (left[s.truth] > 0) {
      left[s.truth]--;
      ids.add(s.id);
    }
  }
  return ids;
}

const collected: Row[] = [];

async function runAll() {
  const scenarios = [...handcrafted(), ...randomScenarios(seed, QUOTA)];
  const subset = subsetIds(scenarios);
  fs.mkdirSync(outDir, { recursive: true });
  const cache: Record<string, LlmRecord> = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : {};
  const useLlm = !noLlm && (!!apiKey || Object.keys(cache).length > 0);
  if (!noLlm && !apiKey) console.warn("No API key: scoring only the model answers already saved.");
  let lastCall = 0;
  let stopped: string | null = null;
  for (const s of scenarios) {
    const { ev } = truthOf(s.facts, s.request);
    const inSubset = llmAll || subset.has(s.id);
    const row: Row = { id: s.id, label: s.label, truth: s.truth, request: s.request, makers: s.facts.makers.length, inSubset, answers: {} as Row["answers"] };
    const run = (name: Approach, a: Answer) => (row.answers[name] = { answer: a, score: score(s, ev, a, { singleMakerOnly: name === "old_haat" }) });
    run("planner", planner(s.facts, s.request));
    run("rule_based", ruleBased(s.facts, s.request));
    run("old_haat", oldHaat(s.facts, s.request));
    row.answers.llm_direct = { answer: null, score: null };
    if (useLlm && inSubset) {
      let rec: LlmRecord | undefined = cache[s.id]?.raw ? cache[s.id] : undefined;
      if (!rec && apiKey && !stopped) {
        const wait = lastCall + 13_000 - Date.now(); // free tier: about 5 requests a minute
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        lastCall = Date.now();
        const r = await askModel(modelId, apiKey, s.facts, s.request);
        if (r.quotaExhausted) stopped = r.error;
        else {
          rec = { raw: r.raw, error: r.error, attempts: r.attempts, ms: r.ms, at: new Date().toISOString() };
          cache[s.id] = rec;
          fs.writeFileSync(cachePath, JSON.stringify(cache, null, 1));
        }
      }
      rec ??= cache[s.id];
      if (rec) {
        row.llm = rec;
        run("llm_direct", rec.raw ? toAnswer(s.facts, s.request, rec.raw) : { kind: "error", reason: rec.error ?? "no answer" });
      }
      process.stdout.write(`${s.id} truth=${s.truth} model=${row.answers.llm_direct.score?.outcome ?? (stopped ? "not asked (quota)" : "—")}\n`);
    }
    collected.push(row);
  }
  if (stopped) console.warn(`Stopped asking the model: daily quota exhausted. Re-run later to continue.\n  ${stopped.slice(0, 160)}`);
  const asked = collected.filter((r) => r.inSubset && r.answers.llm_direct.score).length;
  const meta = {
    seed,
    generatedAt: new Date().toISOString(),
    quota: QUOTA,
    cases: scenarios.length,
    handcrafted: scenarios.filter((s) => s.id.startsWith("h")).length,
    subset: { definition: llmAll ? "all cases" : { handcrafted: "all", ...SUBSET }, size: collected.filter((r) => r.inSubset).length, answeredByModel: asked, complete: !stopped && asked === collected.filter((r) => r.inSubset).length },
    model: useLlm ? { provider: "google", id: modelId, temperature: 0, promptVersion: PROMPT_VERSION, system: SYSTEM } : null,
  };
  fs.writeFileSync(
    outJson,
    JSON.stringify({ meta, rows: collected, scenarios: scenarios.map((s) => ({ id: s.id, label: s.label, truth: s.truth, request: s.request, facts: s.facts })) }, (k, v) => (k === "answer" ? summariseAnswer(v) : v), 1),
  );
  const md = report(meta, collected);
  fs.writeFileSync(path.join(outDir, `seed-${seed}.md`), md);
  console.log(md);
}

const pct = (n: number, d: number) => (d ? `${n}/${d}` : "—");
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const asPct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);

type Meta = { seed: number; cases: number; handcrafted: number; model: { id: string; promptVersion: string } | null; generatedAt: string; subset: { size: number; answeredByModel: number; complete: boolean } };

function tables(rows: Row[], used: readonly Approach[]): string[] {
  const count = (a: Approach, o: Outcome | Outcome[], filter: (r: Row) => boolean = () => true) =>
    rows.filter((r) => filter(r) && r.answers[a]?.score && ([] as Outcome[]).concat(o).includes(r.answers[a].score!.outcome)).length;
  const head = `| | ${used.map((a) => LABEL[a]).join(" | ")} |`;
  const sep = `|---|${used.map(() => "---").join("|")}|`;
  const answered = (a: Approach) => rows.filter((r) => r.answers[a]?.score && !["unsupported", "error"].includes(r.answers[a].score!.outcome)).length;
  const lines = [head, sep];
  lines.push(`| Cases answered (excl. unsupported / errors) | ${used.map((a) => answered(a)).join(" | ")} |`);
  lines.push(`| Right decision | ${used.map((a) => pct(count(a, ["correct_yes", "correct_no", "correct_undecided"]), answered(a))).join(" | ")} |`);
  lines.push(`| **Unsafe promises** (a yes that breaks a fact, or is over budget) | ${used.map((a) => count(a, ["unsafe_yes", "over_budget_yes"])).join(" | ")} |`);
  lines.push(`| Orders missed (said no when a valid plan existed) | ${used.map((a) => count(a, "missed")).join(" | ")} |`);
  lines.push(`| Wrong kind of no | ${used.map((a) => count(a, "wrong_kind")).join(" | ")} |`);
  lines.push(`| Unsupported (reported separately) | ${used.map((a) => count(a, "unsupported")).join(" | ")} |`);
  lines.push(`| No answer (errors) | ${used.map((a) => count(a, "error")).join(" | ")} |`);
  const gaps = (a: Approach) => rows.filter((r) => r.truth === "yes" && r.answers[a]?.score?.outcome === "correct_yes" && r.answers[a].score!.priceGap !== null).map((r) => r.answers[a].score!.priceGap!);
  lines.push(`| Price above the cheapest possible (median / worst, valid yeses) | ${used.map((a) => { const g = gaps(a); return g.length ? `${asPct(median(g))} / ${asPct(Math.max(...g))}` : "—"; }).join(" | ")} |`);
  const maxClaims = (a: Approach) => rows.filter((r) => r.answers[a]?.score?.maxClaim).map((r) => r.answers[a].score!.maxClaim);
  lines.push(`| "Most we can do" exact, when saying no to capacity | ${used.map((a) => { const m = maxClaims(a); return m.length ? `${m.filter((x) => x === "exact").length}/${m.length}` : "—"; }).join(" | ")} |`);
  lines.push("", "By the true answer:", "", head, sep);
  for (const t of ["yes", "no_capacity", "no_budget", "undecided"] as Truth[]) {
    const n = rows.filter((r) => r.truth === t).length;
    if (!n) continue;
    const right = (a: Approach) => count(a, ["correct_yes", "correct_no", "correct_undecided"], (r) => r.truth === t);
    const unsafe = (a: Approach) => count(a, ["unsafe_yes", "over_budget_yes"], (r) => r.truth === t);
    const uns = (a: Approach) => count(a, "unsupported", (r) => r.truth === t);
    const err = (a: Approach) => count(a, "error", (r) => r.truth === t);
    lines.push(`| ${t.replace("_", " ")} (${n}) | ${used.map((a) => `${right(a)} right${unsafe(a) ? `, ${unsafe(a)} unsafe` : ""}${uns(a) ? `, ${uns(a)} unsupported` : ""}${err(a) ? `, ${err(a)} no answer` : ""}`).join(" | ")} |`);
  }
  lines.push("", "What the unsafe promises broke:", "");
  for (const a of used) {
    const cats = new Map<string, number>();
    for (const r of rows) {
      const sc = r.answers[a]?.score;
      if (!sc || !["unsafe_yes", "over_budget_yes"].includes(sc.outcome)) continue;
      for (const c of sc.outcome === "over_budget_yes" ? ["over the buyer's budget"] : sc.categories) cats.set(c, (cats.get(c) ?? 0) + 1);
    }
    lines.push(`- **${LABEL[a]}:** ${cats.size ? [...cats].sort((x, y) => y[1] - x[1]).map(([c, n]) => `${c} (${n})`).join(", ") : "none"}`);
  }
  return lines;
}

export function report(meta: Meta, rows: Row[]): string {
  const lines: string[] = [];
  lines.push(`# Evaluation results — seed ${meta.seed}`, "");
  lines.push(`${meta.cases} cases (${meta.handcrafted} hand-written, ${meta.cases - meta.handcrafted} generated from the seed). Generated ${meta.generatedAt.slice(0, 10)}.`);
  lines.push("Every schedule is judged by the independent checker. Truth is the planner's answer after the checker accepts it, so the planner's own column is a consistency check, not evidence; its correctness rests on the checker and the exhaustive reference tests.", "");

  lines.push(`## All ${rows.length} cases: deterministic approaches`, "");
  lines.push(...tables(rows, ["planner", "rule_based", "old_haat"]), "");

  const sub = rows.filter((r) => r.inSubset);
  lines.push(`## The AI subset: all four approaches on the same ${sub.length} cases`, "");
  if (!meta.model) lines.push("The AI model was not run.");
  else {
    lines.push(`AI model: \`${meta.model.id}\`, temperature 0, prompt \`${meta.model.promptVersion}\` (no tools, no solver). It answered ${meta.subset.answeredByModel} of ${sub.length} cases${meta.subset.complete ? "." : " — **incomplete**: the rest were not asked yet (daily quota)."}`, "");
    const answeredRows = sub.filter((r) => r.answers.llm_direct.score);
    lines.push(...tables(answeredRows, APPROACHES), "");
    if (answeredRows.length < sub.length) lines.push(`(Only the ${answeredRows.length} cases the model answered are in this table, for every approach.)`, "");
    const stated = answeredRows.map((r) => r.answers.llm_direct.score?.statedPriceRight).filter((x): x is boolean => x !== null && x !== undefined);
    if (stated.length) lines.push(`The AI model's stated price equalled the correct price of its own schedule in ${stated.filter(Boolean).length} of ${stated.length} "yes" answers.`, "");
  }
  const disagree = rows.flatMap((r) => APPROACHES.filter((a) => r.answers[a]?.score?.truthDisagreement).map((a) => `${r.id}/${a}`));
  lines.push(disagree.length ? `**Checker-valid answers that disagree with the planner (investigate):** ${disagree.join(", ")}` : "No checker-valid answer from any approach contradicted the planner's answer.", "");
  lines.push("## Every case", "", `| Case | Truth | In AI subset | ${APPROACHES.map((a) => LABEL[a]).join(" | ")} |`, `|---|---|---|${APPROACHES.map(() => "---").join("|")}|`);
  for (const r of rows) lines.push(`| ${r.id} | ${r.truth.replace("_", " ")} | ${r.inSubset ? "yes" : ""} | ${APPROACHES.map((a) => (r.answers[a]?.score?.outcome ?? "—").replace(/_/g, " ")).join(" | ")} |`);
  return lines.join("\n") + "\n";
}

runAll().catch((e) => {
  console.error(e);
  process.exit(1);
});
