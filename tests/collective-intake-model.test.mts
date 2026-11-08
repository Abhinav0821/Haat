import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "test";
process.env.PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "test";
process.env.PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || "test";

/** Review finding 3: the model that answered is recorded; the evaluation never falls back, retries or mixes models. */

const { APICallError } = await import("ai");
const { MockLanguageModelV4 } = await import("ai/test");
const { withFallback } = await import("@/lib/ai/model");
const { readRaw } = await import("@/lib/ai/collective-intake");

const CTX = { today: "2026-11-09", earliest: "2026-11-19", inrPerUsd: 88, product: "scarf", collective: "C" };
const heard = { quantity: 30, quantityWords: "30", deliverBy: "2026-12-10", deliverByWords: "by Dec 10", budget: null, budgetWords: null, item: "scarves", matchesProduct: "yes", details: null, unclear: [] };
const ok = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
  warnings: [],
});
const rateLimited = () => new APICallError({ message: "Resource exhausted", url: "https://example.test", requestBodyValues: {}, statusCode: 429, isRetryable: true });

test("app path: when the primary is rate-limited and a fallback answers, the fallback is recorded as the model", async () => {
  let primaryCalls = 0;
  const models: Record<string, InstanceType<typeof MockLanguageModelV4>> = {
    primary: new MockLanguageModelV4({ modelId: "primary", doGenerate: async () => { primaryCalls++; throw rateLimited(); } }),
    backup: new MockLanguageModelV4({ modelId: "backup", doGenerate: async () => ok(JSON.stringify(heard)) }),
  };
  const chain = withFallback("primary", ["backup"], (id) => models[id] as never);
  const r = await readRaw("30 scarves by Dec 10", CTX, { model: chain });
  assert.equal(r.modelId, "backup");
  assert.equal(primaryCalls, 1, "no automatic SDK retries on top of the fallback chain");
});

test("evaluation: one request per case to one fixed model; a 429 stops the run; only the requested model's answers are scored", async () => {
  const { main, CASES, fromRequestedModel } = await import("../eval/intake");
  process.env.EVAL_MODEL = "model-a";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intake-eval-"));
  let calls = 0;
  const ask = async (modelId: string, _key: string, text: string) => {
    calls++;
    const at = new Date().toISOString();
    if (calls === 4) return { raw: null, error: "Resource exhausted", requested: modelId, served: null, attempts: 1, status: 429, at };
    if (calls === 2) return { raw: heard, error: null, requested: modelId, served: "model-b", attempts: 1, status: null, at }; // answered by another model
    return { raw: { ...heard, quantity: text.length }, error: null, requested: modelId, served: `${modelId}-001`, attempts: 1, status: null, at };
  };
  const noWait = async () => undefined;
  const first = await main(["--run"], ask, dir, noWait);
  assert.equal(calls, 4, "stops at the first 429");
  assert.equal(first.requests, 4, "each case is exactly one request");
  assert.equal(first.scored, 2, "the other model's answer and the 429 are not scored");
  const second = await main(["--run"], ask, dir, noWait);
  assert.ok(second.requests <= CASES.length, "never more requests than cases");
  assert.equal(fromRequestedModel({ raw: heard, error: null, requested: "model-a", served: "model-b", attempts: 1, status: null, at: "" }, "model-a"), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
