import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { APICallError, wrapLanguageModel } from "ai";
import { env } from "@/lib/env";

/**
 * Single place that decides which LLM the app uses.
 *
 *   AI_PROVIDER=google  → Gemini (GOOGLE_API_KEY, GOOGLE_MODEL) — free tier available
 *   AI_PROVIDER=openai  → OpenAI or any OpenAI-compatible gateway
 *                         (OPENAI_API_KEY, OPENAI_MODEL, optional OPENAI_BASE_URL)
 *
 * If AI_PROVIDER is unset, Google is used when GOOGLE_API_KEY is present.
 */

export type AiProvider = "google" | "openai";

export function aiProvider(): AiProvider {
  const e = env();
  if (e.AI_PROVIDER) return e.AI_PROVIDER;
  return e.GOOGLE_API_KEY ? "google" : "openai";
}

export function aiModelId(): string {
  return aiProvider() === "google" ? env().GOOGLE_MODEL : env().OPENAI_MODEL;
}

function openAiBaseUrl(): string {
  const { OPENAI_BASE_URL, OPENAI_API_KEY } = env();
  if (OPENAI_BASE_URL) return OPENAI_BASE_URL.replace(/\/$/, "");
  if (OPENAI_API_KEY?.startsWith("sk-or-")) return "https://openrouter.ai/api/v1";
  return "https://api.openai.com/v1";
}

function requireKey(name: "GOOGLE_API_KEY" | "OPENAI_API_KEY"): string {
  const key = env()[name];
  if (!key) throw new Error(`${name} is empty in .env.local (AI_PROVIDER=${aiProvider()})`);
  return key;
}

/** Overloaded (503), rate-limited (429) or other transient provider errors. */
class ModelTimeout extends Error {}

/** A model attempt that hangs is treated like an overloaded one: move on to the next model. */
const ATTEMPT_TIMEOUT_MS = Number(process.env.AI_ATTEMPT_TIMEOUT_MS ?? 30_000);
function withTimeout<T>(p: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve(p),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new ModelTimeout(`model attempt exceeded ${ATTEMPT_TIMEOUT_MS} ms`)), ATTEMPT_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

function isCapacityError(e: unknown): boolean {
  if (e instanceof ModelTimeout) return true;
  if (!APICallError.isInstance(e)) return false;
  return e.isRetryable || e.statusCode === 429 || e.statusCode === 503 || e.statusCode === 500;
}

/**
 * Wrap a primary model so that capacity errors transparently fall through to
 * the next model in the chain. On Gemini's free tier each model has its own
 * quota, so a chain also multiplies headroom — important for a live demo.
 */
export function withFallback(primaryId: string, ids: string[], make: (id: string) => ReturnType<typeof googleModel>) {
  const fallbacks = ids.map((id) => ({ id, m: make(id) }));
  return wrapLanguageModel({
    model: make(primaryId),
    middleware: {
      specificationVersion: "v4",
      // The answer records the model that actually produced it (never the primary's name for a fallback's answer).
      wrapGenerate: async ({ doGenerate, params }) => {
        try {
          const r = await withTimeout(doGenerate());
          return { ...r, response: { ...r.response, modelId: r.response?.modelId || primaryId } };
        } catch (e) {
          if (!isCapacityError(e)) throw e;
          let last = e;
          for (const fb of fallbacks) {
            console.warn(`[ai] ${(last as Error).message.slice(0, 50)}… → trying ${fb.id}`);
            try {
              const r = await withTimeout(fb.m.doGenerate(params));
              return { ...r, response: { ...r.response, modelId: fb.id } };
            } catch (err) {
              if (!isCapacityError(err)) throw err;
              last = err;
            }
          }
          throw last;
        }
      },
      wrapStream: async ({ doStream, params }) => {
        try {
          return await doStream();
        } catch (e) {
          if (!isCapacityError(e)) throw e;
          let last = e;
          for (const fb of fallbacks) {
            console.warn(`[ai] ${(last as Error).message.slice(0, 50)}… → streaming from ${fb.id}`);
            try {
              return await fb.m.doStream(params);
            } catch (err) {
              if (!isCapacityError(err)) throw err;
              last = err;
            }
          }
          throw last;
        }
      },
    },
  });
}

/** One fixed Gemini model: no fallback chain (for evaluations, where the model must not change silently). */
export function fixedGoogleModel(id: string, apiKey?: string) {
  return createGoogleGenerativeAI({ apiKey: apiKey ?? requireKey("GOOGLE_API_KEY") })(id);
}

function googleModel(id: string) {
  return createGoogleGenerativeAI({ apiKey: requireKey("GOOGLE_API_KEY") })(id);
}

export function model() {
  if (aiProvider() === "google") {
    const fallbacks = env()
      .GOOGLE_FALLBACK_MODELS.split(",")
      .map((s) => s.trim())
      .filter((s) => s && s !== env().GOOGLE_MODEL);
    return withFallback(env().GOOGLE_MODEL, fallbacks, googleModel);
  }
  const baseURL = openAiBaseUrl();
  const provider = createOpenAI({ apiKey: requireKey("OPENAI_API_KEY"), baseURL, name: "llm" });
  // OpenAI itself → Responses API (SDK default); gateways → Chat Completions.
  return baseURL.includes("api.openai.com") ? provider(env().OPENAI_MODEL) : provider.chat(env().OPENAI_MODEL);
}

/** Model ids this key can use — for diagnostics (`npm run smoke`). */
export async function listAvailableModels(): Promise<{ endpoint: string; ids: string[] }> {
  if (aiProvider() === "google") {
    const endpoint = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000";
    const res = await fetch(endpoint, { headers: { "x-goog-api-key": requireKey("GOOGLE_API_KEY") } });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
    const ids = (data.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""));
    return { endpoint: "Google Gemini API", ids };
  }
  const base = openAiBaseUrl();
  const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${requireKey("OPENAI_API_KEY")}` } });
  if (!res.ok) throw new Error(`${base} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { data: { id: string }[] };
  return { endpoint: base, ids: data.data.map((m) => m.id) };
}
