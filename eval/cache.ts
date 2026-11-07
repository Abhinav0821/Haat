import { createHash } from "node:crypto";
import { canonical } from "@/lib/passport/signing";
import { LlmAnswer, type LlmRecord, type modelInput } from "./llm";

export type ModelInput = Awaited<ReturnType<typeof modelInput>>;
export type CachedAnswer = { v: 2; fingerprint: string; input: ModelInput; runs: LlmRecord[] };
export const inputFingerprint = (input: ModelInput) => createHash("sha256").update(canonical(input)).digest("hex");

/** Old unbound entries, changed inputs and corrupted output are never silently reused. */
export function matchingCache(value: unknown, input: ModelInput): CachedAnswer | null {
  if (!value || typeof value !== "object") return null;
  const c = value as CachedAnswer;
  if (c.v !== 2 || c.fingerprint !== inputFingerprint(input) || !c.input || inputFingerprint(c.input) !== c.fingerprint || !Array.isArray(c.runs) || !c.runs.length) return null;
  for (const r of c.runs) {
    if (!r || !Number.isInteger(r.attempts) || r.attempts < 1 || !Number.isFinite(r.ms) || r.ms < 0 || (r.error !== null && typeof r.error !== "string")) return null;
    if (r.raw !== null && !LlmAnswer.safeParse(r.raw).success) return null;
    if (r.raw === null && !r.error) return null;
  }
  return c;
}

export function saveAnswer(input: ModelInput, result: LlmRecord, previous?: CachedAnswer | null): CachedAnswer {
  return { v: 2, fingerprint: inputFingerprint(input), input, runs: [...(previous?.runs ?? []), result] };
}

export function reusableAnswer(c: CachedAnswer | null, retryErrors = false): LlmRecord | null {
  const last = c?.runs.at(-1);
  // Quota/rate limits are infrastructure interruptions, resumed on a later invocation.
  if (!last || last.quotaExhausted || (retryErrors && last.raw === null)) return null;
  return last;
}
