# Haat

**Make any small seller shoppable by humans and AI agents, using PayPal.**

Haat (Hindi for *village market*) lets a small cross-border seller snap photos of their products and get three things:

1. **A PayPal-powered storefront** for human buyers.
2. **An MCP endpoint** that lets AI shopping agents (Claude, ChatGPT, …) find products and start a PayPal checkout. The human buyer still approves every payment.
3. **An AI back office** that drafts refunds (the seller approves by saying a code word), adds tracking numbers she speaks, drafts invoices, and records dispute events for her attention. It never moves money without her approval.

> Built for the [PayPal AI Hackathon 2026](https://paypalaihackathon.devpost.com/).

**For sellers (voice-first, Hindi):** list a product by photo + voice note · fair-price advice from live market prices (Channel3) · buyer messages translated and read aloud · 🛡️ Scam Shield (incl. fake payment-screenshot detection verified against PayPal) · refunds approved by saying a code word · tracking numbers spoken straight into PayPal · a daily summary in Hindi with exact PayPal fees · ⚖️ her own costs, minimum earnings and capacity, set by voice and enforced in code · 🪡 Maker Evidence (signed record of possession + photo checks — not proof of authorship) · 🎙️ "पूछो हाट" voice assistant that drafts PayPal invoices with QR codes.
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

## Maker economics & stock

The maker states her costs, minimum and capacity **by voice** (“materials ₹350, packing ₹50, shipping costs me ₹1,200, charge the buyer $15, I need at least ₹1,500 per piece, four a week”). Gemini only extracts the numbers; Haat reads them back from a fixed template and nothing applies until she approves. One deterministic calculation is then used everywhere:

```
buyer pays            = goods + shipping CHARGED
left for her work (₹) = (buyer pays − est. PayPal fee) × est. ₹/$ − shipping COST − materials − packaging − other
```

Fee and exchange rate are labelled estimates (the actual fee is recorded from PayPal at capture). “Loss” is only said when the result is negative; otherwise “below your minimum”. Missing costs produce a question, not a number. She hears the result before publishing, and can correct a listing by voice (“दाम 1800 कर दो”, “यह सूती है”).

**One-of-a-kind stock:** each order reserves the piece under a row lock; every capture path (browser, agent return URL, webhook) re-checks the reservation, re-holding an expired one only if the piece is still free and otherwise refusing to capture (the buyer is never charged). Captures are counted once, including duplicate and recovered webhooks. Covered by concurrency tests (2 buyers / 1 piece, 10 agents / 3 pieces).

## Maker Evidence

A record of what was checked — not a guarantee. Each check reports its own result and scope: a photo of the piece beside a one-time handwritten code (passed / failed / uncertain), a Channel3 visual retail search (no match / possible match / not run), and a photo comparison with other Haat listings (no similar photo / similar found). It is “complete” only when all three ran and passed. **It shows the maker had this piece recently and that its photos are original; it does not prove who made it or how.** Records are Ed25519-signed (`/api/passport/{productId}`, key at `/api/passport/public-key`) — the signature proves the record is unchanged, not that its claims are true. MCP returns each check's stored result and the limitation (`withMakerEvidenceOnly` filter).

## पूछो हाट (Ask Haat)

A Hindi voice assistant for the seller. It answers from our records and PayPal's own data (Agent Toolkit `list_transactions`), and **drafts** actions — PayPal invoices (`create_invoice` → `send_invoice` → `generate_invoice_qr_code`, shareable on WhatsApp) and replies to buyers — that run only after the seller taps confirm. It cannot move money; refunds stay behind the spoken code word.

## How PayPal and AI are used

| Capability | PayPal technology | AI role |
|---|---|---|
| Checkout | Orders v2 (create / capture), JS SDK | none: kept deterministic on purpose |
| Catalog | Catalog Products API via **PayPal Agent Toolkit** | Vision model turns product photos into listings |
| Agent shopping | MCP server → Orders v2 approval link | Buyer's own AI assistant |
| Back office | Agent Toolkit: shipment tracking, refunds, invoices (+QR), transactions; dispute events recorded | Agents draft; a policy engine and the seller's spoken approval decide |

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

## What Haat does not do (yet)

Being explicit about scope:

- **Finding buyers.** The storefront and MCP endpoint make her work available; they don't create demand. A real deployment needs a channel — an artisan collective, export partner or existing customers.
- **Export readiness.** PayPal India requires identity verification, PAN, bank details, purpose codes and (for goods) an IEC. Haat doesn't collect or automate these.
- **Shipping logistics.** No labels, customs forms or courier booking — only the shipping charge, her shipping cost, and tracking.
- **Dispute resolution.** Dispute events are recorded and surfaced; there is no full evidence-and-response workflow.
- **Multiple sellers.** The demo runs one maker; tables are keyed by store for later separation.
- **Languages.** Hindi is tested end to end; other Indian languages are supported by the model but not validated with users.

## License

[MIT](LICENSE)
