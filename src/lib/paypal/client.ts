import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Minimal, typed PayPal REST client.
 *
 * Used for the money-moving paths we keep deterministic (order create/capture,
 * webhook verification) and for APIs the Agent Toolkit doesn't cover.
 * Every write carries a PayPal-Request-Id so retries are idempotent.
 */

const BASE_URLS = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
} as const;

export function paypalBaseUrl(): string {
  return BASE_URLS[env().PAYPAL_ENV];
}

export class PayPalApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: { name?: string; message?: string; debug_id?: string; details?: unknown } | string,
    readonly path: string,
  ) {
    const issues = typeof body === "string" || !Array.isArray(body.details) ? [] : (body.details as { issue?: string }[]).map((d) => d?.issue).filter((x): x is string => !!x);
    const summary =
      typeof body === "string" ? body.slice(0, 300) : `${body.name ?? "ERROR"}: ${body.message ?? ""}${issues.length ? ` [${issues.join(", ")}]` : ""}${body.debug_id ? ` (debug_id ${body.debug_id})` : ""}`;
    super(`PayPal ${status} on ${path} — ${summary}`);
    this.name = "PayPalApiError";
  }

  get debugId(): string | undefined {
    return typeof this.body === "string" ? undefined : this.body.debug_id;
  }
}

type TokenCache = { token: string; expiresAt: number; appId?: string; scope?: string };
let tokenCache: TokenCache | null = null;

export async function getAccessToken(): Promise<TokenCache> {
  // Refresh a minute early to avoid using a token that expires mid-request.
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache;

  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = env();
  const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${paypalBaseUrl()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const body = await parseBody(res);
  if (!res.ok) throw new PayPalApiError(res.status, body, "/v1/oauth2/token");

  const data = body as unknown as { access_token: string; expires_in: number; app_id?: string; scope?: string };
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    appId: data.app_id,
    scope: data.scope,
  };
  return tokenCache;
}

export type PayPalRequest = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** Idempotency key. Auto-generated for writes if omitted. */
  requestId?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

export async function paypal<T = unknown>(path: string, req: PayPalRequest = {}): Promise<T> {
  const method = req.method ?? "GET";
  const { token } = await getAccessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
    ...req.headers,
  };
  if (method !== "GET") headers["PayPal-Request-Id"] = req.requestId ?? randomUUID();

  const res = await fetch(`${paypalBaseUrl()}${path}`, {
    method,
    headers,
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
    signal: req.signal,
  });
  const body = await parseBody(res);
  if (!res.ok) throw new PayPalApiError(res.status, body, path);
  return body as unknown as T;
}

type ErrorBody = PayPalApiError["body"];

async function parseBody(res: Response): Promise<ErrorBody> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ── Orders v2 (deterministic checkout path — never driven by an LLM) ──────────

export type PayPalLink = { href: string; rel: string; method?: string };
export type PayPalOrder = {
  id: string;
  status: string;
  links?: PayPalLink[];
  purchase_units?: unknown[];
};

export function approveLink(order: PayPalOrder): string | undefined {
  return order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
}
