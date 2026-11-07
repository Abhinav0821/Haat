import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { askModel, modelInput, type LlmRaw } from "../eval/llm";
import { inputFingerprint, matchingCache, reusableAnswer, saveAnswer } from "../eval/cache";
import { runAll } from "../eval/run";
import { handcrafted } from "../eval/scenarios";

const example = handcrafted()[1];
const raw: LlmRaw = { decision: "cannot_decide", production: [], finishing: [], priceUsdCents: null, maxQuantityByDate: null, reason: "Need confirmation" };

async function fakeProvider(status: number, text: string, maxAttempts = 1) {
  const original = globalThis.fetch;
  let calls = 0;
  const waits: number[] = [];
  globalThis.fetch = (async () => {
    calls++;
    const body = status === 200
      ? { candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 } }
      : { error: { code: status, message: text, status: status === 429 ? "RESOURCE_EXHAUSTED" : "INVALID_ARGUMENT" } };
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await askModel("gemini-3.6-flash", "FAKE-OFFLINE-TEST", example.facts, example.request, { maxAttempts, wait: async (ms) => { waits.push(ms); } });
    return { result, calls, waits };
  } finally { globalThis.fetch = original; }
}

test("malformed model output is one recorded result, even when transient retries are explicitly allowed", async () => {
  const { result, calls, waits } = await fakeProvider(200, "not valid JSON", 3);
  assert.equal(calls, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.raw, null);
  assert.match(result.error!, /No object generated/);
  assert.deepEqual(waits, []);
});

test("429 stops immediately and a nonretryable API error reports its actual one attempt", async () => {
  const limited = await fakeProvider(429, "Quota exceeded", 3);
  assert.equal(limited.calls, 1);
  assert.equal(limited.result.quotaExhausted, true);
  assert.deepEqual(limited.waits, []);
  const invalid = await fakeProvider(400, "Invalid argument", 3);
  assert.equal(invalid.calls, 1);
  assert.equal(invalid.result.attempts, 1);
});

test("transient failures have no automatic retry by default and explicit retries never sleep after the last attempt", async () => {
  const once = await fakeProvider(503, "Unavailable");
  assert.equal(once.calls, 1);
  assert.deepEqual(once.waits, []);
  const retried = await fakeProvider(503, "Unavailable", 3);
  assert.equal(retried.calls, 3);
  assert.equal(retried.result.attempts, 3);
  assert.deepEqual(retried.waits, [30_000, 60_000]);
  const valid = await fakeProvider(200, JSON.stringify(raw));
  assert.deepEqual(valid.result.raw, raw);
  assert.equal(valid.calls, 1);
});

test("cache identity covers raw facts, request, full prompt, model and output schema", async () => {
  const input = await modelInput("gemini-test", example.facts, example.request);
  const entry = saveAnswer(input, { raw, error: null, attempts: 1, ms: 2 });
  assert.ok(matchingCache(JSON.parse(JSON.stringify(entry)), input));
  for (const edit of [
    (x: typeof input) => { x.facts.makers[0].floorInrPerPiece.value++; },
    (x: typeof input) => { x.request.quantity++; },
    (x: typeof input) => { x.system += "changed"; },
    (x: typeof input) => { x.prompt += "changed"; },
    (x: typeof input) => { x.model = "another-model"; },
    (x: typeof input) => { x.schema = { type: "string" }; },
  ]) {
    const changed = structuredClone(input); edit(changed);
    assert.notEqual(inputFingerprint(changed), entry.fingerprint);
    assert.equal(matchingCache(entry, changed), null);
  }
  assert.equal(matchingCache({ raw }, input), null, "unbound legacy caches are refused");
  const corrupt = structuredClone(entry); corrupt.runs[0].raw = { nonsense: true } as unknown as LlmRaw;
  assert.equal(matchingCache(corrupt, input), null);
});

test("saved errors are terminal by default and explicit retries retain their history", async () => {
  const input = await modelInput("test", example.facts, example.request);
  const error = { raw: null, error: "No object generated", attempts: 1, ms: 3 };
  const entry = saveAnswer(input, error);
  assert.deepEqual(reusableAnswer(entry), error);
  assert.equal(reusableAnswer(entry, true), null);
  const retried = saveAnswer(input, { raw, error: null, attempts: 1, ms: 5 }, entry);
  assert.equal(retried.runs.length, 2);
  assert.equal(retried.runs[0].error, error.error);
});

test("quota interruption resumes matching cases once, keeps errors, and deterministic runs preserve AI reports", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "haat-eval-resume-"));
  let calls = 0;
  const options = { outDir, noLlm: false, apiKey: "FAKE-NO-NETWORK", modelId: "offline-test", wait: async () => {} };
  const first = await runAll({ ...options, ask: async () => {
    calls++;
    return { raw: null, error: calls === 1 ? "Malformed output" : "429 quota", attempts: 1, ms: 1, ...(calls === 2 ? { quotaExhausted: true } : {}) };
  } });
  assert.equal(calls, 2);
  assert.equal(first.meta.subset.scoredCases, 1);
  assert.equal(first.meta.subset.complete, false);
  const resumed = await runAll({ ...options, ask: async () => { calls++; return { raw, error: null, attempts: 1, ms: 1 }; } });
  assert.equal(calls, 19); // one malformed + one quota interruption + 17 remaining cases
  assert.equal(resumed.meta.requestsThisRun, 17);
  assert.equal(resumed.meta.requestsRecorded, 19);
  assert.equal(resumed.meta.subset.answeredByModel, 17);
  assert.equal(resumed.meta.subset.complete, true);
  const again = await runAll({ ...options, ask: async () => { throw new Error("must use cache"); } });
  assert.equal(again.meta.requestsThisRun, 0);
  const aiFile = path.join(outDir, "seed-20261108-ai.json");
  const before = fs.readFileSync(aiFile, "utf8");
  await runAll({ outDir, noLlm: true, ask: async () => { throw new Error("no model calls"); } });
  assert.equal(fs.readFileSync(aiFile, "utf8"), before);
});
