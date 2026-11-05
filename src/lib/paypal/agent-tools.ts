import type { FlexibleSchema, ToolSet } from "ai";
import { ALL_TOOLS_ENABLED, PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";
import { env } from "@/lib/env";

/**
 * Bridge between PayPal's Agent Toolkit and the AI SDK we use.
 *
 * The toolkit (v1.11) builds tools for AI SDK v4 (`{ description, parameters,
 * execute }`); our app runs AI SDK v7 (`inputSchema`). We re-wrap each tool and,
 * crucially, only expose an explicit allowlist per agent. A buyer-facing agent
 * must never be handed refund / invoice / dispute tools.
 */

/** Toolkit tool names, as published in github.com/paypal/agent-toolkit. */
export type PayPalToolName =
  | "create_product" | "list_products" | "show_product_details" | "update_product"
  | "create_order" | "get_order" | "pay_order" | "create_refund" | "get_refund"
  | "create_shipment_tracking" | "get_shipment_tracking" | "update_shipment_tracking"
  | "list_disputes" | "get_dispute" | "accept_dispute_claim"
  | "create_invoice" | "list_invoices" | "get_invoice" | "send_invoice" | "send_invoice_reminder"
  | "list_transactions" | "get_merchant_insights";

type ToolInput = Record<string, unknown>;
type LegacyTool = {
  description?: string;
  parameters: FlexibleSchema<ToolInput>; // zod v3 schema
  execute: (args: ToolInput, options?: unknown) => Promise<unknown>;
};

let toolkit: PayPalAgentToolkit | null = null;

function getToolkit(): PayPalAgentToolkit {
  if (toolkit) return toolkit;
  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV } = env();
  // Enable every action at the toolkit level; per-agent scoping happens in paypalTools().
  toolkit = new PayPalAgentToolkit({
    clientId: PAYPAL_CLIENT_ID,
    clientSecret: PAYPAL_CLIENT_SECRET,
    configuration: { actions: ALL_TOOLS_ENABLED, context: { sandbox: PAYPAL_ENV === "sandbox" } },
  });
  return toolkit;
}

/** Return AI-SDK-v7 tools for exactly the PayPal actions this agent may use. */
export function paypalTools<const N extends PayPalToolName>(allow: readonly N[]): Record<N, ToolSet[string]> {
  const all = getToolkit().getTools() as unknown as Record<string, LegacyTool>;
  const out = {} as Record<N, ToolSet[string]>;
  for (const name of allow) {
    const legacy = all[name];
    if (!legacy) {
      throw new Error(
        `PayPal toolkit has no tool "${name}". Available: ${Object.keys(all).sort().join(", ")}`,
      );
    }
    // `tool()` is an identity helper for type inference; schemas here are only
    // known at runtime, so we build the v7 tool object directly.
    out[name] = {
      description: legacy.description,
      inputSchema: legacy.parameters,
      execute: async (input: ToolInput) => legacy.execute(input),
    } as ToolSet[string];
  }
  return out;
}

/** Names the installed toolkit actually exposes (useful for diagnostics). */
export function availablePayPalTools(): string[] {
  return Object.keys(getToolkit().getTools()).sort();
}

/**
 * Run one Agent Toolkit action directly from code (no LLM in the loop) — used
 * for deterministic steps such as adding tracking after the seller confirms.
 * The toolkit reports failures in its result text rather than throwing.
 */
export async function runPayPalTool(name: PayPalToolName, args: Record<string, unknown>): Promise<unknown> {
  const legacy = (getToolkit().getTools() as unknown as Record<string, LegacyTool>)[name];
  if (!legacy) throw new Error(`PayPal toolkit has no tool "${name}"`);
  const result = await legacy.execute(args);
  const text = typeof result === "string" ? result : JSON.stringify(result);
  if (/"error"|error:|failed|INVALID_|UNPROCESSABLE|NOT_AUTHORIZED/i.test(text)) {
    throw new Error(`PayPal ${name} failed: ${text.slice(0, 300)}`);
  }
  return result;
}
