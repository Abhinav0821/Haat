# Devpost submission text (draft)

**Project name:** Haat

**Tagline (≤ 200 chars):** Bigger orders for small makers. Haat helps artisan collectives take bulk orders together: plans checked by code, each maker agrees to her part, the buyer pays with PayPal.

**Links**
- Live: https://haat-teal.vercel.app (PayPal sandbox)
- Repo: https://github.com/Abhinav0821/Haat
- Video: _(YouTube link)_

---

## Inspiration

A woman who block-prints scarves at home in Bagru, Rajasthan, can make a few pieces a week.
The buyers who could change her income (boutiques and gifting companies abroad) want 30 or 300
pieces by a date. No single maker can take that order, and taking it as a group is hard. A
coordinator has to reconcile everyone's days, materials, prices and other promises, usually
over the phone, and each maker's pay is mostly a matter of memory.

We wanted a group of makers to assess that order against their recorded capacity,
with each maker agreeing to her own work and pay. Haat records what she is owed and
tracks it until she confirms receipt; it does not guarantee payment or delivery.

## What it does

Haat is a back office for **artisan collectives**: groups of home-based makers with a
coordinator. One order moves through five steps:

1. **The buyer asks** in plain words on the request page, or through **their own AI agent**
   over Haat's MCP server.
   - AI reads the words into quantity, date and budget, and code checks those fields against
     the buyer's words.
   - Anything not actually written is marked "please check". Nothing is planned until the
     buyer confirms.
2. **Haat plans it across the makers** from what's recorded for each one: her working days,
   materials date, other promises and asking price, plus the shared finishing table.
   - A **separate checker, sharing no code with the planner**, verifies every plan, refusal
     and alternative before anyone sees it.
   - There are three honest answers: *yes*, with the cheapest plan; *no*, with the reason and
     what would work; or *not yet*, naming the fact that decides it.
   - It also shows whether any one maker could have done it alone, so the buyer sees what the
     collective adds.
3. **Each maker agrees to her own part** on her personal link, **in Hindi or English**: her
   pieces per day, dispatch date and pay. The terms are read aloud and fingerprinted.
   - If plans change, Haat keeps the parts already agreed and shows what keeping them costs.
4. **The buyer approves the exact terms and pays the collective once with PayPal.** Capacity
   is reserved while they decide, and the terms are locked during capture.
5. **Each maker's share is recorded as owed.** The coordinator pays her by UPI or bank and
   records the reference. **Only her own link can confirm it arrived.**

Our principle: **AI assists. Code checks. Makers decide. Buyers pay with PayPal.**

## How we built it

- **PayPal**
  - Orders v2, with the collective as the seller, and webhooks with signature verification.
    PayPal's own capture record, fee and net are stored.
  - Each PayPal order is bound to one exact version of the terms (by hash).
  - Captures are fenced against races and lost responses. Every capture path shares one
    idempotent finaliser, and a refused capture unlocks the terms for a fresh PayPal order.
- **AI** (Gemini through the Vercel AI SDK)
  - Reads the buyer's request (temperature 0, structured output).
  - Drafts the Hindi requirements, with a **separate back-translation** for the
    coordinator to compare. Both calls use AI; human review is still required.
  - Code grounds quantity, date and budget readings in the buyer's words, resolves relative dates ("next
    Friday", "before Christmas") by published rules, and never lets an amount inside an
    instruction become a budget.
- **Agentic commerce:** a remote MCP server (`get_collective_info`, `request_collective_order`,
  `get_collective_order`).
  - Agents send only the requirements their user confirmed.
  - Agents can't approve or pay, and see only aggregate information, never a maker's name,
    availability or pay.
- **Planning:** a min-cost flow over each maker's days with certificates.
  - A capacity cut proves a "no"; price-level bounds prove "cheapest".
  - The independent checker re-derives everything from the raw facts.
- **Stack:** Next.js 16, TypeScript, PostgreSQL (Neon) with Drizzle, Vercel, 306 automated
  tests.

## Challenges we ran into

- **Making "AI reads the request" trustworthy.** An evaluation re-run caught our own
  regression: new code took "$1" from a prompt-injection sentence as a budget. We fixed it so
  code checks budgets but never supplies one.
- **Consent that survives change.** Every part is hashed. A maker is asked again only when
  *her* part changes, and her language is part of what she agrees to.
- **Payments with uncertain outcomes.** Attempt fences and idempotent finalisation protect
  against duplicate processing and stale refusals. An uncertain capture stays locked
  until PayPal's authoritative record resolves it.
- **A real sandbox surprise.** PayPal's sandbox blocked further international payments into
  our Indian test business account under its KYC compliance rules. Haat now treats a definite
  refusal correctly: nothing charged, terms unlocked, a fresh order next time. The hosted
  demo receives into a US sandbox account; a real Indian collective completes PayPal India's
  KYC.

## Accomplishments that we're proud of

- **Live, end to end:** request → checked plan → three makers agree on their own links →
  PayPal capture → PayPal webhooks delivered → each maker's share. Done on the hosted site,
  including **an order placed by a real AI agent** (Claude Desktop over MCP), paid by the
  human.
- **46 synthetic test cases, 0 unsafe promises from the checked planner.** The old
  single-maker rule made 8 unsafe promises among its 38 supported cases. A careful
  rule-based split also made 0 unsafe promises; the planner found one feasible order it missed.
  The planner's own score is a consistency check against its checked model.
- **AI request reading, measured:** on 20 hand-written requests (ranges, per-piece and rupee
  budgets, euros, vague dates, a prompt injection), **no wrong value was ever shown as the
  buyer's own words**.
- **An honest comparison:** an AI deciding directly made no unsafe promises either, but its
  complete answer (price or maximum) was wrong in 6 of 18 cases, and nothing showed which. So
  in Haat, AI reads and code decides.

The project owner played the buyer, coordinator and makers in these sandbox runs.
The payout confirmation used a test reference, with no real bank transfer. We have not
yet measured real artisan income, adoption or usability with a collective. The 20 intake
requests were also used during prompt development, not held-out real buyer traffic.

## What we learned

The hard part isn't the optimisation. A careful rule-of-thumb split found nearly as many
feasible orders as our planner. The hard part is making every promise **checkable**, every
agreement **specific to one person** and every rupee **traceable** to her confirmation. That's
where AI and payments have to be held to account.

## What's next for Haat

- Sessions with a real coordinator and makers, measuring whether they can keep their facts
  current and understand their own part.
- Additional Indian languages beyond the current Hindi and English maker flow, with
  translations reviewed by native speakers.
- Makers updating their facts by voice in their own language.
- PayPal payouts directly to makers where it's allowed.

## Built with

nextjs · typescript · react · tailwindcss · postgresql · neon · drizzle · vercel · paypal-orders-api · paypal-webhooks · gemini · vercel-ai-sdk · model-context-protocol · zod

## AI tools used

- **Google Gemini** (`gemini-3.6-flash`, through the Vercel AI SDK): reading buyers' requests
  and drafting Hindi requirements with back-translation in the app; the evaluation's AI
  baseline; and, in the single-maker shop, listings, translation and voice.
- **Claude Desktop:** the buyer's AI agent in the recorded MCP run.
- **Claude Code:** coding assistant during development.
- **OpenAI Codex:** code review, implementation corrections, regression tests and
  submission preparation during development.

## Testing instructions for judges

- **Request an order:** open https://haat-teal.vercel.app/c/request, describe an order (e.g.
  "30 indigo scarves delivered in four weeks, total budget $300") and press **Read my request**.
- **Connect your own agent (optional):** https://haat-teal.vercel.app/agent has
  setup for Claude, ChatGPT, Claude Code, Cursor and VS Code (one-click for the last two) and
  example prompts. The server URL is `https://haat-teal.vercel.app/api/mcp`; no sign-in.
- **Complete testing flow:** follow [the judge guide](https://github.com/Abhinav0821/Haat/blob/main/docs/submission/judge-guide.md).
  The coordinator PIN and dedicated sandbox buyer login belong in the submission's
  private testing instructions. Those credentials are needed to complete the payment flow;
  the public request form and MCP server require no Haat login.
- **Run it locally:** setup and tests are in the README (`npm install`, `npm test`).
