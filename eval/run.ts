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
 * stopped by a quota/rate limit resumes where it stopped. Quotas are per Google project,
 * not per key: use EVAL_GOOGLE_API_KEY from a separate project to isolate app quota.
 *
 * Writes eval/results/seed-<seed>.json (every case, answer, score, raw model output)
 * and eval/results/seed-<seed>.md (summary tables).
 */
import { config } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { handcrafted, randomScenarios, truthOf, type Scenario, type Truth } from "./scenarios";
import { oldHaat, planner, ruleBased, type Answer } from "./approaches";
import { askModel, modelInput, PROMPT_VERSION, SYSTEM, toAnswer, type LlmRecord } from "./llm";
import { completeAnswerCorrect, score, type Outcome, type Score } from "./score";

import { inputFingerprint, matchingCache, reusableAnswer, saveAnswer } from "./cache";
export const QUOTA: Record<Truth, number> = { yes: 16, no_capacity: 12, no_budget: 6, undecided: 6 };
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

export type EvalOptions = { seed?: number; noLlm?: boolean; llmAll?: boolean; retryErrors?: boolean; modelId?: string; apiKey?: string; outDir?: string; ask?: typeof askModel; wait?: (ms: number) => Promise<void> };

type Row = { id: string; label: string; truth: Truth; request: Scenario["request"]; makers: number; inSubset: boolean; answers: Record<Approach, { answer: Answer | null; score: Score | null }>; llm?: LlmRecord; llmFingerprint?: string };

const summariseAnswer = (a: Answer | null) => {
  if (!a) return null;
  if (a.kind === "yes") return { kind: a.kind, quantity: a.plan.quantity, priceUsdCents: a.plan.money.priceUsdCents, statedPriceUsdCents: "statedPriceUsdCents" in a ? a.statedPriceUsdCents ?? null : a.plan.money.priceUsdCents, production: a.plan.production, finishing: a.plan.finishing };
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

export async function runAll(options: EvalOptions = {}) {
  const { seed = 20261108, noLlm = true, llmAll = false, retryErrors = false, modelId = "gemini-3.6-flash", apiKey } = options;
  const outDir = options.outDir ?? path.join(process.cwd(), "eval", "results");
  const outJson = path.join(outDir, `seed-${seed}${noLlm ? "" : "-ai"}.json`);
  const cachePath = path.join(outDir, `llm-cache-v2-seed-${seed}-${encodeURIComponent(modelId)}.json`);
  const collected: Row[] = [];
  let requestsThisRun = 0;
  let requestsRecorded = 0;
  const scenarios = [...handcrafted(), ...randomScenarios(seed, QUOTA)];
  const subset = subsetIds(scenarios);
  fs.mkdirSync(outDir, { recursive: true });
  const cache: Record<string, unknown> = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : {};
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
      const input = await modelInput(modelId, s.facts, s.request);
      const fingerprint = inputFingerprint(input);
      const previous = matchingCache(cache[fingerprint], input);
      let rec = reusableAnswer(previous, retryErrors);
      let saved = previous;
      if (!rec && apiKey && !stopped) {
        const wait = lastCall + 13_000 - Date.now();
        if (wait > 0) await (options.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(wait);
        lastCall = Date.now();
        const r = { ...await (options.ask ?? askModel)(modelId, apiKey, s.facts, s.request), at: new Date().toISOString() };
        requestsThisRun += r.attempts;
        saved = saveAnswer(input, r, previous);
        cache[fingerprint] = saved;
        const temporary = `${cachePath}.tmp-${process.pid}`;
        fs.writeFileSync(temporary, JSON.stringify(cache, null, 1));
        fs.renameSync(temporary, cachePath);
        if (r.quotaExhausted) stopped = r.error ?? "Provider rate/quota limit";
        else rec = r;
      }
      requestsRecorded += saved?.runs.reduce((n, r) => n + r.attempts, 0) ?? 0;
      row.llmFingerprint = fingerprint;
      if (rec) {
        row.llm = rec;
        run("llm_direct", rec.raw ? toAnswer(s.facts, s.request, rec.raw) : { kind: "error", reason: rec.error ?? "no answer" });
      }
      process.stdout.write(`${s.id} truth=${s.truth} model=${row.answers.llm_direct.score?.outcome ?? (stopped ? "not asked (quota)" : "—")}\n`);
    }
    collected.push(row);
  }
  if (stopped) console.warn(`Stopped asking the model: provider rate/quota limit. Check AI Studio and re-run later to continue.\n  ${stopped.slice(0, 160)}`);
  const asked = collected.filter((r) => r.inSubset && r.answers.llm_direct.score).length;
  const answered = collected.filter((r) => r.inSubset && r.llm?.raw).length;
  const meta = {
    seed,
    generatedAt: new Date().toISOString(),
    quota: QUOTA,
    cases: scenarios.length,
    handcrafted: scenarios.filter((s) => s.id.startsWith("h")).length,
    subset: { definition: llmAll ? "all cases" : { handcrafted: "all", ...SUBSET }, size: collected.filter((r) => r.inSubset).length, answeredByModel: answered, scoredCases: asked, complete: !stopped && asked === collected.filter((r) => r.inSubset).length },
    requestsThisRun, requestsRecorded, retryErrors,
    model: useLlm ? { provider: "google", id: modelId, temperature: 0, promptVersion: PROMPT_VERSION, system: SYSTEM } : null,
  };
  fs.writeFileSync(
    outJson,
    JSON.stringify({ meta, rows: collected, scenarios: scenarios.map((s) => ({ id: s.id, label: s.label, truth: s.truth, request: s.request, facts: s.facts })) }, (k, v) => (k === "answer" ? summariseAnswer(v) : v), 1),
  );
  const md = report(meta, collected);
  fs.writeFileSync(outJson.replace(/\.json$/, ".md"), md);
  console.log(md);
  return { meta, rows: collected, scenarios };
}

const pct = (n: number, d: number) => (d ? `${n}/${d}` : "—");
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const asPct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);

type Meta = { seed: number; cases: number; handcrafted: number; model: { id: string; promptVersion: string } | null; generatedAt: string; subset: { size: number; answeredByModel: number; scoredCases: number; complete: boolean }; requestsThisRun: number; requestsRecorded: number; retryErrors: boolean };

function tables(rows: Row[], used: readonly Approach[]): string[] {
  const count = (a: Approach, o: Outcome | Outcome[], filter: (r: Row) => boolean = () => true) =>
    rows.filter((r) => filter(r) && r.answers[a]?.score && ([] as Outcome[]).concat(o).includes(r.answers[a].score!.outcome)).length;
  const head = `| | ${used.map((a) => LABEL[a]).join(" | ")} |`;
  const sep = `|---|${used.map(() => "---").join("|")}|`;
  const answered = (a: Approach) => rows.filter((r) => r.answers[a]?.score && !["unsupported", "error"].includes(r.answers[a].score!.outcome)).length;
  const lines = [head, sep];
  lines.push(`| Cases answered (excl. unsupported / errors) | ${used.map((a) => answered(a)).join(" | ")} |`);
  lines.push(`| Decision/schedule correct (price separate) | ${used.map((a) => pct(count(a, ["correct_yes", "correct_no", "correct_undecided"]), answered(a))).join(" | ")} |`);
  lines.push(`| Complete answer correct (quote / maximum included) | ${used.map((a) => pct(rows.filter((r) => r.answers[a]?.score && completeAnswerCorrect(r.answers[a].score!)).length, rows.filter((r) => r.answers[a]?.score && r.answers[a].score!.outcome !== "unsupported").length)).join(" | ")} |`);
  lines.push(`| Incorrect/missing prices on valid yes schedules | ${used.map((a) => rows.filter((r) => r.answers[a]?.score?.outcome === "correct_yes" && r.answers[a].score!.statedPriceRight === false).length).join(" | ")} |`);
  lines.push(`| **Unsafe promises** (a yes that breaks a fact, or is over budget) | ${used.map((a) => count(a, ["unsafe_yes", "over_budget_yes"])).join(" | ")} |`);
  lines.push(`| Orders missed (said no when a valid plan existed) | ${used.map((a) => count(a, "missed")).join(" | ")} |`);
  lines.push(`| Refusal category differs from M1 | ${used.map((a) => count(a, "wrong_kind")).join(" | ")} |`);
  lines.push(`| Unsupported (reported separately) | ${used.map((a) => count(a, "unsupported")).join(" | ")} |`);
  lines.push(`| No answer (errors) | ${used.map((a) => count(a, "error")).join(" | ")} |`);
  const gaps = (a: Approach) => rows.filter((r) => r.truth === "yes" && r.answers[a]?.score?.outcome === "correct_yes" && r.answers[a].score!.priceGap !== null).map((r) => r.answers[a].score!.priceGap!);
  lines.push(`| Valid yes schedules with a certified minimum for price comparison | ${used.map((a) => gaps(a).length).join(" | ")} |`);
  lines.push(`| Calculated cost of valid schedules above cheapest (median / worst) | ${used.map((a) => { const g = gaps(a); return g.length ? `${asPct(median(g))} / ${asPct(Math.max(...g))}` : "—"; }).join(" | ")} |`);
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

  lines.push("Decision/schedule correctness does not repair an incorrect quote. Complete-answer correctness also requires a correct quote at the minimum price where a certified minimum exists, and an exact stated maximum for a capacity refusal; errors count as failures in that denominator. Price gaps are not computed against uncertified minima.", "");
  lines.push(`## All ${rows.length} cases: deterministic approaches`, "");
  lines.push(...tables(rows, ["planner", "rule_based", "old_haat"]), "");

  const sub = rows.filter((r) => r.inSubset);
  lines.push(`## The AI subset: all four approaches on the same ${sub.length} cases`, "");
  if (!meta.model) lines.push("The AI model was not run.");
  else {
    lines.push(`AI model: \`${meta.model.id}\`, temperature 0, prompt \`${meta.model.promptVersion}\` (no tools, no solver). It produced ${meta.subset.answeredByModel} answers; ${meta.subset.scoredCases} of ${sub.length} cases were processed (malformed output counts as an error)${meta.subset.complete ? "." : " — **incomplete**: remaining cases are pending."}`, "");
    lines.push(`Provider requests this invocation: ${meta.requestsThisRun}; recorded across resumptions: ${meta.requestsRecorded}. Automatic retries: off.`, "");
    if (meta.retryErrors) lines.push("Explicit retries of previous errors were requested; full attempt histories are retained in the cache. Treat this as a rerun, not first-attempt accuracy.", "");
    const answeredRows = sub.filter((r) => r.answers.llm_direct.score);
    lines.push(...tables(answeredRows, APPROACHES), "");
    if (answeredRows.length < sub.length) lines.push(`(Only the ${answeredRows.length} cases the model answered are in this table, for every approach.)`, "");
    const stated = answeredRows.filter((r) => r.answers.llm_direct.answer?.kind === "yes").map((r) => r.answers.llm_direct.score?.statedPriceRight).filter((x): x is boolean => x !== null && x !== undefined);
    if (stated.length) lines.push(`The AI model's stated price equalled the correct price of its own schedule in ${stated.filter(Boolean).length} of ${stated.length} "yes" answers.`, "");
  }
  const disagree = rows.flatMap((r) => APPROACHES.filter((a) => r.answers[a]?.score?.truthDisagreement).map((a) => `${r.id}/${a}`));
  lines.push(disagree.length ? `**Checker-valid answers that disagree with the planner (investigate):** ${disagree.join(", ")}` : "No checker-valid answer from any approach contradicted the planner's answer.", "");
  lines.push("## Every case", "", `| Case | Truth | In AI subset | ${APPROACHES.map((a) => LABEL[a]).join(" | ")} |`, `|---|---|---|${APPROACHES.map(() => "---").join("|")}|`);
  for (const r of rows) lines.push(`| ${r.id} | ${r.truth.replace("_", " ")} | ${r.inSubset ? "yes" : ""} | ${APPROACHES.map((a) => (r.answers[a]?.score?.outcome ?? "—").replace(/_/g, " ")).join(" | ")} |`);
  return lines.join("\n") + "\n";
}

// Importing report/runAll in tests never reads keys or starts a model run.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  config({ path: ".env.local", quiet: true });
  const args = process.argv.slice(2), seedAt = args.indexOf("--seed");
  const seed = seedAt >= 0 ? Number(args[seedAt + 1]) : 20261108;
  if (!Number.isSafeInteger(seed)) throw new Error("--seed needs a whole number");
  runAll({ seed, noLlm: args.includes("--no-llm"), llmAll: args.includes("--llm-all"), retryErrors: args.includes("--retry-errors"),
    modelId: process.env.EVAL_MODEL || process.env.GOOGLE_MODEL || "gemini-3.6-flash", apiKey: process.env.EVAL_GOOGLE_API_KEY || process.env.GOOGLE_API_KEY,
  }).catch((e) => { console.error(e); process.exitCode = 1; });
}
