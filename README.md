# Haat

**Make any small seller shoppable by humans and AI agents, using PayPal.**

Haat (Hindi for *village market*) lets a small cross-border seller snap photos of their products and get three things:

1. **A PayPal-powered storefront** for human buyers.
2. **An MCP endpoint** that lets AI shopping agents (Claude, ChatGPT, …) find products and start a PayPal checkout. The human buyer still approves every payment.
3. **An AI back-office "autopilot"** that handles shipment tracking, refunds, disputes and invoices through PayPal APIs. It never moves money without the seller's approval.

> Built for the [PayPal AI Hackathon 2026](https://paypalaihackathon.devpost.com/).

**For sellers (voice-first, Hindi):** list a product by photo + voice note · fair-price advice from live market prices (Channel3) · buyer messages translated and read aloud · 🛡️ Scam Shield (incl. fake payment-screenshot detection verified against PayPal) · refunds approved by saying a code word · tracking numbers spoken straight into PayPal · a daily summary in Hindi with exact PayPal fees · 🪡 Handmade Passport (signed, AI-verified proof of handmade) · 🎙️ "पूछो हाट" voice assistant that drafts PayPal invoices with QR codes.
**For buyers and their AI agents:** an editorial storefront with the maker's own voice · PayPal JS SDK v6 checkout · an MCP server so Claude/ChatGPT can shop on the buyer's behalf (the human always approves payment).

## Quick start

Requirements: **Node.js 20+**. No database to install: an embedded Postgres runs automatically.

```bash
git clone <this repo> haat && cd haat
npm install
cp .env.example .env.local   # then fill in the keys (see below)
npm run smoke                # checks PayPal sandbox + AI + DB connectivity
npm run dev                  # http://localhost:3000  (seller studio: /seller — enter SELLER_PASSCODE)
```

### Keys you need

| Variable | Where to get it |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | [developer.paypal.com](https://developer.paypal.com/dashboard/applications/sandbox) → Apps & Credentials → **Sandbox** → Create App (Merchant) |
| `GOOGLE_API_KEY` | Free at [aistudio.google.com](https://aistudio.google.com/apikey) → Get API key. Alternatively set `AI_PROVIDER=openai` + `OPENAI_API_KEY`. `npm run smoke` lists the models your key can use |

| `SELLER_PASSCODE` | Any 4–12 digit PIN. Unlocks the seller studio (`/seller`). Without it the seller area stays locked. |
| `CHANNEL3_API_KEY` *(optional)* | [channel3.ai](https://channel3.ai) — enables the fair-price coach (1 credit per listing). |

Everything runs against the **PayPal sandbox**. No real money moves.

### Useful scripts

| Command | What it does |
|---|---|
| `npm test` | Unit tests (policy engine, webhooks, Scam Shield, code words, pricing, brief, auth) |
| `npm run smoke` | Live connectivity check: PayPal Orders/Invoicing/Disputes/Reporting, Gemini, Agent Toolkit |
| `npm run tunnel` | Public HTTPS URL for PayPal webhooks and for connecting AI agents to `/api/mcp` |
| `npm run demo:reset` | Clear test orders/messages (backs up the local DB first; stop `npm run dev` before running) |

## Shop with an AI agent (MCP)

Haat exposes a remote MCP server at `/api/mcp` (Streamable HTTP). Add it as a custom connector in Claude or ChatGPT, e.g. `https://<your-host>/api/mcp`.

| Tool | What it does |
|---|---|
| `search_products` | Search the makers' live products by keyword / max price |
| `get_product` | Details, plus the maker's own words (original language + English) |
| `create_checkout` | Creates a PayPal order **at the shop's price** and returns a PayPal link the **human must approve**; the agent can never pay |
| `get_order_status` | CREATED → APPROVED → COMPLETED |
| `message_maker` / `get_messages` | Ask the maker; she reads it in her language and replies by voice, translated back |

Seller-written text is returned under `sellerProvided` and labelled as data, so a crafted product description can't instruct the buyer's agent.

## Scam Shield

Every buyer message is translated into the maker's language and checked for the scams that target new cross-border sellers: fake "I already paid" claims (verified against **PayPal's own order status**), ship-to-another-address requests (which void Seller Protection), off-PayPal payment, overpayment refunds, pressure tactics and attempts to instruct the AI. Warnings come from fixed Hindi/English templates and are read aloud first; buyers never see the verdict.

## Handmade Passport

Proof that a piece is genuinely handmade by this maker: a fresh photo of the piece beside a one-time handwritten code (read by AI vision; digits must match), a Channel3 visual search for an identical mass-market product, and perceptual-hash checks against every other listing. Hard failures reject; soft signals hold for review. Verified passports are **Ed25519-signed** (`/api/passport/{productId}`, public key at `/api/passport/public-key`) and exposed to AI agents via MCP (`verifiedHandmadeOnly`). We deliberately don't claim to detect AI-generated images.

## पूछो हाट (Ask Haat)

A Hindi voice assistant for the seller. It answers from our records and PayPal's own data (Agent Toolkit `list_transactions`), and **drafts** actions — PayPal invoices (`create_invoice` → `send_invoice` → `generate_invoice_qr_code`, shareable on WhatsApp) and replies to buyers — that run only after the seller taps confirm. It cannot move money; refunds stay behind the spoken code word.

## How PayPal and AI are used

| Capability | PayPal technology | AI role |
|---|---|---|
| Checkout | Orders v2 (create / capture), JS SDK | none: kept deterministic on purpose |
| Catalog | Catalog Products API via **PayPal Agent Toolkit** | Vision model turns product photos into listings |
| Agent shopping | MCP server → Orders v2 approval link | Buyer's own AI assistant |
| Autopilot | Agent Toolkit: shipment tracking, refunds, disputes, invoices, transactions, insights | Event-driven agent with a policy engine and an approval inbox |

**Seller security:** the studio is behind a PIN. Sessions are signed, httpOnly cookies (HMAC-SHA256, 30 days); passcodes are compared in constant time and login attempts are rate-limited. A Next.js Proxy redirects unauthenticated visitors, and every seller API re-checks the session itself.

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
