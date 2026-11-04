# Haat

**Make any small seller shoppable by humans and AI agents, using PayPal.**

Haat (Hindi for *village market*) lets a small cross-border seller snap photos of their products and get three things:

1. **A PayPal-powered storefront** for human buyers.
2. **An MCP endpoint** that lets AI shopping agents (Claude, ChatGPT, …) find products and start a PayPal checkout. The human buyer still approves every payment.
3. **An AI back-office "autopilot"** that handles shipment tracking, refunds, disputes and invoices through PayPal APIs. It never moves money without the seller's approval.

> Built for the [PayPal AI Hackathon 2026](https://paypalaihackathon.devpost.com/). 🚧 Work in progress.

## Quick start

Requirements: **Node.js 20+**. No database to install: an embedded Postgres runs automatically.

```bash
git clone <this repo> haat && cd haat
npm install
cp .env.example .env.local   # then fill in the keys (see below)
npm run smoke                # checks PayPal sandbox + AI + DB connectivity
npm run dev                  # http://localhost:3000
```

### Keys you need

| Variable | Where to get it |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | [developer.paypal.com](https://developer.paypal.com/dashboard/applications/sandbox) → Apps & Credentials → **Sandbox** → Create App (Merchant) |
| `GOOGLE_API_KEY` | Free at [aistudio.google.com](https://aistudio.google.com/apikey) → Get API key. Alternatively set `AI_PROVIDER=openai` + `OPENAI_API_KEY`. `npm run smoke` lists the models your key can use |

Everything runs against the **PayPal sandbox**. No real money moves.

## How PayPal and AI are used

| Capability | PayPal technology | AI role |
|---|---|---|
| Checkout | Orders v2 (create / capture), JS SDK | none: kept deterministic on purpose |
| Catalog | Catalog Products API via **PayPal Agent Toolkit** | Vision model turns product photos into listings |
| Agent shopping | MCP server → Orders v2 approval link | Buyer's own AI assistant |
| Autopilot | Agent Toolkit: shipment tracking, refunds, disputes, invoices, transactions, insights | Event-driven agent with a policy engine and an approval inbox |

**Safety principle:** the model proposes and code decides. Each agent receives an explicit PayPal tool allowlist (`src/lib/paypal/agent-tools.ts`). Money-moving actions pass deterministic policy checks and human approval, and every action is written to an audit log.

## Project layout

```
src/lib/paypal/client.ts       PayPal REST client (OAuth, idempotency keys, errors)
src/lib/paypal/agent-tools.ts  PayPal Agent Toolkit → AI SDK bridge with per-agent allowlists
src/lib/ai/model.ts            LLM provider (one place to swap models)
src/db/                        Drizzle schema (stores, products, orders, agent actions, webhook events)
scripts/smoke-test.ts          End-to-end connectivity check
```

## AI tools used

- **Google Gemini** (via the Vercel AI SDK; OpenAI-compatible models also supported): catalog generation from photos, the seller autopilot agent, and the in-store concierge.
- **PayPal Agent Toolkit** (`@paypal/agent-toolkit`): exposes PayPal APIs as agent tools.
- **Claude Code**: used as a coding assistant during development.

## License

[MIT](LICENSE)
