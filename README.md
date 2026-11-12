# Haat: bigger orders for small makers

Haat helps artisan collectives turn bulk requests into checked work plans, get each maker's
agreement on her part, collect one buyer payment through PayPal, and track each maker's
share until she confirms receipt.

**AI assists. Code checks. Makers decide. Buyers pay with PayPal.**

> Built for the [PayPal AI Hackathon 2026](https://paypalaihackathon.devpost.com/). **[Watch the 3-minute demo](https://youtu.be/JWpLjkx_Hnk)** · Live: [haat-teal.vercel.app](https://haat-teal.vercel.app) · Direction and claim boundaries: [docs/direction.md](docs/direction.md).

## Who it is for

Existing artisan collectives in India that make a standard product for overseas boutiques and
gifting buyers, with a coordinator who already manages the work. The demo is three block
printers in Bagru who share one finishing table and make hand block-printed cotton scarves.

A home-based maker can make a few pieces a week. When a buyer asks for 30 or 300 by a date,
the coordinator has to reconcile several makers' availability, materials, prices and other
promises. Haat gives the group a shared, checked plan, and gives each maker a clear record
of her own work and pay.

## How an order moves

```mermaid
flowchart LR
  B["Buyer's words<br/>(or the buyer's AI agent, MCP)"] --> AI["AI proposes a reading<br/>quantity · date · budget"]
  AI --> C["Buyer edits and confirms"]
  C --> P["Planner<br/>(min-cost flow over the makers' days)"]
  P --> K{"Independent checker<br/>(shares no code with the planner)"}
  K -- "yes: checked plan" --> M["Each maker agrees to her part<br/>on her own link, in Hindi or English"]
  K -- "no: reason + checked alternatives" --> CO["Coordinator"]
  K -- "not yet: focused question" --> CO
  M --> A["Buyer approves the exact terms<br/>(capacity reserved)"]
  A --> PP["PayPal Orders v2<br/>buyer pays the collective"]
  PP --> S["Each maker's share: owed → reported (UPI/bank ref) → confirmed by her"]
```

1. **The request.** The buyer describes the order on `/c/request`, or the buyer's agent calls
   the MCP tool `request_collective_order`.
   - AI proposes values for four fields only: quantity, date, budget and a description.
   - Code checks each value against the buyer's words. A number not found there, or a date
     the words don't state explicitly, is marked "please check". A missing value stays
     empty, with a question.
   - Only what the buyer confirms becomes the order.
2. **The plan.** Haat plans the order across the makers' recorded days, materials dates,
   other promises, caps and asking prices, plus the shared finishing table. Each answer
   goes through the independent checker before anyone sees it. There are three answers:
   - **Yes**, with the cheapest plan. "Cheapest" is certified when every maker's facts are
     complete.
   - **No**, with the reason (a capacity cut or a certified minimum price) and checked
     alternatives: the most pieces by the date, the earliest date for all of them, or the
     most pieces within the budget.
   - **Not decided yet**, with what's missing. If one unknown materials date is all that
     blocks the answer, the coordinator gets the date that decides it, checked at both
     ends.
3. **Alone or together.** The coordinator sees what each maker could do alone. When no maker
   could do it alone and the group can, both answers checked, the buyer sees exactly one
   sentence: "No individual maker can fulfil this request within its date and budget. The
   collective can." There are no names or figures in it.
4. **Her part.** Each maker sees only her own part (pieces per day, pay, dispatch date) on
   her personal link, in Hindi or English as she chooses. The terms are read back in her
   language and hashed. If a plan changes, the
   coordinator can send one that keeps the agreed parts identical; only makers whose part
   changed are asked again.
5. **Payment.** The buyer approves the exact terms. Capacity is re-checked and reserved in
   the same transaction. The buyer then pays the collective, which is the seller, through
   PayPal. Haat records PayPal's own capture, fee and net.
6. **Her share.** The coordinator pays each maker outside Haat (UPI or bank) and records the
   reference. The payment counts as received only when she confirms it on her link.

## What we have shown, and what we haven't

**Comparative evaluation:** 46 synthetic cases (6 hand-written, 40 generated from seed
`20261108`). Every answer was judged by the same independent checker. Details are in
[docs/evaluation.md](docs/evaluation.md) and
[eval/results/seed-20261108.md](eval/results/seed-20261108.md).

| | Planner (M1) | Rule-based split | Old Haat (one maker) |
|---|---|---|---|
| Decision correct | 46/46 | 44/46 | 29/38 (8 unsupported) |
| Complete answer correct (price and maximum included) | 46/46 | 43/46 | 13/38 |
| Unsafe promises | 0 | 0 | 8 |

- On these cases, the planner and a careful rule-based split both made **no unsafe
  promises**. The planner found one feasible order the rule missed, and differed once on
  how to classify incomplete facts.
- The planner's own column is a consistency check against its checked model, not
  independent evidence.
- The old single-maker rule's 8 unsafe promises show why it was replaced. They don't show
  that coordinators make those mistakes.
- **AI deciding directly** (`gemini-3.6-flash`, 18 of the cases): 16/18 right decisions and
  no unsafe promises. Its complete answer, price or maximum included, was wrong in 6 of 18
  cases, and nothing in its output shows which. That's why Haat's AI only reads the request
  and code decides.
- **AI reading buyers' requests** (20 hand-written requests, 60 fields): no wrong value was
  ever shown as "from your words". 49 values were read right and shown as stated, and the rest
  were flagged or left for the buyer. Code reads quantities, amounts and dates itself, resolves
  relative dates by published rules, and flags any disagreement with the AI. The prompt
  injection produced no budget.

**One complete sandbox transaction:**
- A 30-scarf order for $236.86, made by two makers.
- PayPal capture `6XH61035R53768108`, COMPLETED. PayPal's actual fee was $11.26 against an
  estimate of $10.72.
- One maker's ₹4,200 share was reported with a test UPI reference and confirmed on her link.

This proves the integration works end to end. The payout was not a real bank transfer, and
the maker was played by the project owner. It does not show an artisan earning income.

**An order placed by a buyer's AI agent on the live site:**
- **The agent:** Claude Desktop, connected to Haat's MCP server.
- **What it did:** confirmed 24 scarves by Dec 15 (budget $300) with the buyer, sent the
  request and said it couldn't pay.
- **What followed:** each maker accepted her part on her link, and the buyer paid $205.11
  through PayPal (capture `8DM9884353731852U`). PayPal's webhooks were delivered and processed,
  and the makers' shares were created.
- **What the agent saw:** asked for the status, it reported "paid", with no maker names or pay.

Details are in [docs/evaluation.md §3](docs/evaluation.md). The project owner played the
buyer, coordinator and makers.

**Sandbox account note.** The earlier $236.86 local transaction went into an Indian sandbox
business account. Afterwards, PayPal's sandbox refused further international payments
into that account:
- `COMPLIANCE_VIOLATION` at capture;
- then `COMPLIANCE_KYC_VIOLATION` before checkout opened.

A sandbox account can't complete PayPal India's identity checks (KYC). The hosted demo
therefore receives payments into a **US sandbox business account**. A real Indian collective
completes PayPal India's KYC, PAN and purpose-code requirements, which Haat doesn't automate.
The later $205.11 hosted Claude-agent transaction used this US sandbox account.
When PayPal refuses a capture, Haat shows that nothing was charged, unlocks the terms and
lets the buyer pay again with a new PayPal order.

**Not yet established:** real use by a collective, extra orders won, or whether makers can
keep their facts current without help. These need sessions with a real coordinator and
makers, which have not been run yet.

**What "checked" means:** a plan is consistent with the facts recorded for the makers. It
cannot show those facts are true, that every piece will match, or that a courier will be on
time. A personal link proves possession of the link, not identity.

## Quick start

Requirements: **Node.js 20+**. No database to install: an embedded Postgres runs automatically.

```bash
git clone https://github.com/Abhinav0821/Haat.git haat
cd haat
npm ci
cp .env.example .env.local   # then fill in the keys (see below)
npm run smoke                # checks PayPal sandbox + AI + DB connectivity
npm run dev                  # http://localhost:3000
```

- **Buyer:** `/c/request` makes a bulk request. `/c/orders/{id}` shows the terms, approval
  and PayPal payment.
- **Coordinator:** `/seller/collective`, after entering `SELLER_PASSCODE`. It covers
  makers' facts, plans, the alone-or-together check, sending parts, payouts, and personal
  links.
- **Maker:** `/m/{token}`, her personal link, shown once to the coordinator. It covers her
  facts, her parts, and confirming each payment.

### Keys you need

| Variable | Where to get it |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | [developer.paypal.com](https://developer.paypal.com/dashboard/applications/sandbox) → Apps & Credentials → **Sandbox** → Create App (Merchant) |
| `GOOGLE_API_KEY` | Free at [aistudio.google.com](https://aistudio.google.com/apikey). Alternatively set `AI_PROVIDER=openai` and `OPENAI_API_KEY`. Without a working key, buyers fill in the request form themselves. |
| `SELLER_PASSCODE` | Any 4–12 digit PIN. Unlocks the studio (`/seller`). |
| `CHANNEL3_API_KEY` *(optional)* | Only for the single-maker shop's fair-price coach. |

Everything runs against the **PayPal sandbox**. No real money moves.

| Command | What it does |
|---|---|
| `npm test` | The full test suite, on embedded PGlite (or PostgreSQL with `DATABASE_URL=…`) |
| `npm run eval` | The comparative evaluation (deterministic; the AI baseline uses the Gemini quota and is cached per case) |
| `npm run smoke` | Live connectivity check: PayPal, Gemini, Agent Toolkit |
| `npm run demo:reset` | Clear test orders and requests (backs up the local database first; stop `npm run dev` before running) |
| `npm run db:migrate` | Apply migrations (runs automatically in the Vercel build) |

**Deploying:** free on Vercel + Neon. See [DEPLOY.md](DEPLOY.md).

**Judges:** [step-by-step demo instructions](docs/testing.md) cover the
buyer, coordinator, maker and sandbox payment flow. The studio PIN and sandbox buyer
login are supplied in the submission's private testing instructions.

## Agents (MCP)

`/api/mcp` is a remote MCP server (Streamable HTTP, no sign-in). Setup for Claude, ChatGPT,
Claude Code, Cursor and VS Code, with example prompts, is on
[haat-teal.vercel.app/agent](https://haat-teal.vercel.app/agent). For collective orders:

| Tool | What it does |
|---|---|
| `get_collective_info` | The collective, its product, the earliest delivery date that can be asked for, and what to confirm with the user |
| `request_collective_order` | Sends the requirements the user confirmed (quantity, delivery date, optional budget and details). Returns today's checked first answer and the link where the **human** sees the terms, approves and pays |
| `get_collective_order` | Status and terms, in aggregate only: no maker's name, availability or pay |

Agents cannot approve terms or pay. The single-maker shop's tools (search, checkout,
messages, custom orders) are listed in [docs/single-maker.md](docs/single-maker.md).

## How PayPal and AI are used

| Step | PayPal | AI | Code that decides |
|---|---|---|---|
| Request | none | Reads the buyer's words into a proposal (Gemini, temperature 0) | Grounding against the words; only buyer-confirmed fields become the order |
| Plan | none | none | Min-cost flow planner; independent checker; certificates for every refusal and alternative |
| Payment | Orders v2: the collective is the seller; capture lease; webhooks; PayPal's own fee and net recorded | none | One capture per plan, bound to the approved terms' hash |
| Maker payouts | none (paid outside PayPal by UPI or bank) | none | Owed → reported with reference → confirmed by her link |

AI is kept out of anything that sets a quantity, date or price for the makers. The
evaluation includes an AI model deciding directly, to show why.

### Sponsor integration: Channel3

The single-maker shop (see [Also built](#also-built)) uses the
[Channel3](https://channel3.ai) product-search API in two places:

- **Fair-price coach:** when a maker lists a piece, Haat fetches live retail prices of similar
  products from Channel3 and shows them beside her price. She still decides the price.
- **Maker Evidence:** a Channel3 visual search for the same product at mass-market retailers,
  one of the checks behind a piece's "handmade" evidence. A search can miss products, and
  the page says so.

Both are optional: without `CHANNEL3_API_KEY` they are skipped and everything else works.
The collective flow above doesn't use Channel3.

## Contracts

- [docs/direction.md](docs/direction.md): direction, sections A–D, and the claims we make and don't.
- [docs/planner-model.md](docs/planner-model.md): model M1, certificates, extension M1-Q1 (one unknown materials date).
- [docs/collective-consent.md](docs/collective-consent.md): consent, reservations, payment, payouts, requests, keeping agreed parts.
- [docs/evaluation.md](docs/evaluation.md): evaluation method and results.
- [docs/testing.md](docs/testing.md): how to test the live demo, step by step.

## Also built

Haat began as a voice-first back office for a single maker: listings from a photo, Scam Shield, custom orders
held to her stated costs, Maker Evidence and a Hindi assistant. It is still in the app and
tested. It is described in [docs/single-maker.md](docs/single-maker.md).

## Scope of this version

- **Product.** One product family per order, with interchangeable pieces and one shared
  finishing stage. Mixed products are out of scope.
- **Buyers.** Payments are through PayPal, for overseas buyers. Domestic Indian buyers
  would need another payment route.
- **Payouts.** Maker payouts happen outside Haat. Haat records them and the maker confirms;
  it doesn't move the money.
- **No pilot yet.** Whether people can keep their facts current and understand their part
  has not yet been measured with real users.
- **No notifications.** No email or SMS. Buyers and makers open their links.

## AI tools used

- **Google Gemini** (via the Vercel AI SDK): buyer request reading; in the single-maker shop, listings, translation and voice.
- **PayPal Agent Toolkit** (`@paypal/agent-toolkit`): single-maker back office.
- **Claude Code**: coding assistant during development.

## License

[MIT](LICENSE)
