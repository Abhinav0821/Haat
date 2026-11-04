/**
 * Day-1 smoke test: proves every external dependency works before we build features.
 *   npm run smoke
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { generateText, stepCountIs } from "ai";
import { sql } from "drizzle-orm";
import { env } from "@/lib/env";
import { approveLink, getAccessToken, paypal, PayPalApiError, type PayPalOrder } from "@/lib/paypal/client";
import { paypalTools } from "@/lib/paypal/agent-tools";
import { aiModelId, aiProvider, listAvailableModels, model } from "@/lib/ai/model";
import { db } from "@/db";

type Result = { name: string; status: "pass" | "warn" | "fail"; detail: string };
const results: Result[] = [];

async function check(name: string, fn: () => Promise<string>, { warnOnly = false } = {}) {
  process.stdout.write(`… ${name}\r`);
  try {
    const detail = await fn();
    results.push({ name, status: "pass", detail });
  } catch (e) {
    const detail =
      e instanceof PayPalApiError
        ? `${e.message}${e.debugId ? ` (debug_id ${e.debugId})` : ""}`
        : e instanceof Error
          ? e.message
          : String(e);
    results.push({ name, status: warnOnly ? "warn" : "fail", detail });
  }
  const r = results.at(-1)!;
  const icon = { pass: "✅", warn: "⚠️ ", fail: "❌" }[r.status];
  console.log(`${icon} ${name}\n   ${r.detail.split("\n").join("\n   ")}`);
}

async function main() {
  try {
    env();
  } catch (e) {
    console.error(`❌ ${(e as Error).message}\n\nFill in .env.local, then run \`npm run smoke\` again.`);
    process.exit(1);
  }

  console.log(`\nHaat smoke test — PayPal ${env().PAYPAL_ENV}, AI ${aiProvider()}:${aiModelId()}\n`);

  await check("Database (embedded Postgres or DATABASE_URL)", async () => {
    const d = await db();
    // PGlite returns { rows }, postgres-js returns an array.
    const rows = (await d.execute(sql`select count(*)::int as n from stores`)) as unknown as
      | { rows: { n: number }[] }
      | { n: number }[];
    const n = Array.isArray(rows) ? rows[0]?.n : rows.rows[0]?.n;
    return `migrations applied, stores table has ${n} rows`;
  });

  await check("PayPal OAuth (client credentials)", async () => {
    const t = await getAccessToken();
    return `token ok, app_id ${t.appId ?? "?"}, expires ${new Date(t.expiresAt).toLocaleTimeString()}`;
  });

  await check("PayPal Orders v2 — create a $1.00 USD order", async () => {
    const order = await paypal<PayPalOrder>("/v2/checkout/orders", {
      method: "POST",
      body: {
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: "USD", value: "1.00" }, description: "Haat smoke test" }],
      },
    });
    return `order ${order.id} (${order.status})\napprove as the US buyer: ${approveLink(order)}`;
  });

  await check(
    "PayPal Invoicing API",
    async () => {
      const r = await paypal<{ total_items?: number }>("/v2/invoicing/invoices?page_size=1&total_required=true");
      return `reachable, ${r.total_items ?? 0} invoices`;
    },
    { warnOnly: true },
  );

  await check(
    "PayPal Disputes API",
    async () => {
      const r = await paypal<{ items?: unknown[] }>("/v1/customer/disputes?page_size=1");
      return `reachable, ${r.items?.length ?? 0} disputes on first page`;
    },
    { warnOnly: true },
  );

  await check(
    "PayPal Transaction Search (reporting)",
    async () => {
      const end = new Date();
      const start = new Date(end.getTime() - 30 * 86_400_000);
      const q = new URLSearchParams({
        start_date: start.toISOString().replace(/\.\d+Z$/, "Z"),
        end_date: end.toISOString().replace(/\.\d+Z$/, "Z"),
        fields: "all",
        page_size: "1",
      });
      const r = await paypal<{ total_items?: number }>(`/v1/reporting/transactions?${q}`);
      return `reachable, ${r.total_items ?? 0} transactions in last 30 days`;
    },
    { warnOnly: true },
  );

  await check("AI key + model access", async () => {
    const { endpoint, ids } = await listAvailableModels();
    const wanted = aiModelId();
    if (!ids.includes(wanted)) {
      const varName = aiProvider() === "google" ? "GOOGLE_MODEL" : "OPENAI_MODEL";
      const likely = ids.filter((i) => /gemini|gpt|sol|astra|(^|\/)o\d/i.test(i));
      const list = (likely.length ? likely : ids).sort().slice(0, 60).join("\n  ");
      throw new Error(`model "${wanted}" not found at ${endpoint}.\nSet ${varName} to the exact id, e.g.:\n  ${list}`);
    }
    return `key ok via ${endpoint}, ${wanted} available`;
  });

  await check("AI agent → PayPal Agent Toolkit (create + list catalog product)", async () => {
    const tools = paypalTools(["create_product", "list_products"]);
    const { text, steps } = await generateText({
      model: model(),
      tools,
      stopWhen: stepCountIs(5),
      system: "You manage a PayPal product catalog. Use the tools; do not invent IDs.",
      prompt:
        'Create a PHYSICAL product named "Haat smoke test – block-print scarf" with a one-line description. ' +
        "Then list products and reply with the new product's ID only.",
    });
    const calls = steps.flatMap((s) => s.toolCalls.map((c) => c.toolName));
    if (!calls.includes("create_product")) throw new Error(`model never called create_product (calls: ${calls.join(", ") || "none"})`);
    return `tool calls: ${calls.join(" → ")}\nagent reply: ${text.trim().slice(0, 200)}`;
  });

  const failed = results.filter((r) => r.status === "fail").length;
  const warned = results.filter((r) => r.status === "warn").length;
  console.log(`\n${results.length - failed - warned} passed, ${warned} warnings, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main();
