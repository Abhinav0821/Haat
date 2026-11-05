import { z } from "zod";

const required = (hint: string) => z.string({ required_error: `missing — ${hint}` }).min(1, `missing — ${hint}`);
const PAYPAL_HINT = "copy it from developer.paypal.com → Apps & Credentials (Sandbox)";

const EnvSchema = z.object({
  PAYPAL_CLIENT_ID: required(PAYPAL_HINT),
  PAYPAL_CLIENT_SECRET: required(PAYPAL_HINT),
  PAYPAL_ENV: z.enum(["sandbox", "live"]).default("sandbox"),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  /** "google" | "openai". Unset → google if GOOGLE_API_KEY is present. */
  AI_PROVIDER: z.enum(["google", "openai"]).optional(),
  GOOGLE_API_KEY: z.string().optional(),
  GOOGLE_MODEL: z.string().min(1).default("gemini-3.6-flash"),
  /** Comma-separated models to try when the primary is overloaded / rate-limited. */
  GOOGLE_FALLBACK_MODELS: z.string().default("gemini-3.5-flash,gemini-3.7-flash,gemini-3.1-flash-lite"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().min(1).default("gpt-5-mini"),
  /** Optional: OpenAI-compatible gateway, e.g. https://openrouter.ai/api/v1 */
  OPENAI_BASE_URL: z.string().url().optional(),
  DATABASE_URL: z.string().optional(),
  APP_URL: z.string().url().default("http://localhost:3000"),
  /** Shown to the seller when converting their stated INR price; they confirm the final USD price. */
  INR_PER_USD: z.coerce.number().positive().default(88),
  /** Optional: Channel3 product search for the fair-price coach (channel3.ai). */
  CHANNEL3_API_KEY: z.string().optional(),
}).superRefine((e, ctx) => {
  const provider = e.AI_PROVIDER ?? (e.GOOGLE_API_KEY ? "google" : "openai");
  const key = provider === "google" ? "GOOGLE_API_KEY" : "OPENAI_API_KEY";
  if (!e[key]) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [key],
      message:
        provider === "google"
          ? "missing — free key at aistudio.google.com → Get API key"
          : "missing — set GOOGLE_API_KEY (free, aistudio.google.com) or an OpenAI-compatible key",
    });
  }
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/**
 * Validated environment. Read lazily so `next build` doesn't fail on
 * machines that haven't configured secrets yet.
 */
export function env(): Env {
  if (cached) return cached;
  const blankToUndefined: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(process.env).map(([k, v]) => [k, v === "" ? undefined : v]),
  );
  // On Vercel, default the public URL to the production domain (PayPal return/cancel links use it).
  if (!blankToUndefined.APP_URL && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    blankToUndefined.APP_URL = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  const parsed = EnvSchema.safeParse(blankToUndefined);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment (.env.local):\n${problems}`);
  }
  cached = parsed.data;
  return cached;
}
