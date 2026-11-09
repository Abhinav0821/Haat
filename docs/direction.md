# Direction (frozen 2026-11-08)

## Haat: bigger orders for small makers

Haat helps artisan collectives turn bulk requests into checked work plans, get each
maker's agreement on her part, collect one buyer payment through PayPal, and track each
maker's share until she confirms receipt.

**AI assists. Code checks. Makers decide. Buyers pay with PayPal.**

### Who it is for first

Existing artisan collectives in India that make a standardised product (the demo: hand
block-printed cotton scarves) for **overseas** boutiques and gifting buyers, with a
coordinator who already manages the work. This matches what the planner represents
(one product family, interchangeable pieces, one shared finishing stage) and what PayPal
supports for Indian sellers (international payments). Mixed products, wedding orders and
domestic Indian buyers are out of scope for this version.

### The problem we start from

When a bulk request arrives, a coordinator must reconcile several makers' availability,
materials, prices and existing promises. Haat gives the group a shared plan and gives each
maker a clear record of her own work and pay.

### The loop

1. **The buyer asks** in plain words, or through their own AI agent (MCP). AI proposes an
   interpretation; the buyer edits and confirms it. Only confirmed requirements are
   planned.
2. **Haat plans it** across the makers. Every plan is checked against the availability,
   materials, prices and existing commitments **recorded** for the makers, by a checker
   that shares no code with the planner. There are three answers:
   - *Yes*: a checked plan;
   - *No*: with the reason (capacity or budget) and checked alternatives;
   - *We need more information*: with focused questions.
3. **Each maker agrees on her personal link**, in Hindi, to her own part only: pieces,
   days and pay. Changed terms require renewed buyer approval and renewed approval from
   the makers whose parts changed. Unchanged parts keep their agreement.
4. **The buyer approves the exact terms and pays the collective** through PayPal. The
   collective is the seller.
5. **Each maker's share is recorded as owed.** The coordinator pays makers outside Haat
   (UPI or bank) and records the reference; the maker confirms receipt on her link.

### What "checked" means, and what it does not

The checker establishes that a plan, refusal or alternative is consistent with the
recorded facts. It cannot establish that the facts are true, that quality will be
consistent, or that a courier will arrive on time. A personal link proves possession of
the link, not identity.

### Technical claims (as implemented and tested)

Planning claims are independently checked. Missing facts are turned into focused
questions. Replanning preserves existing agreements where possible.

---

## A. AI request intake and the buyer-agent entry

**Flow:** buyer's words → AI interpretation → buyer edits → confirmed requirements →
checked plan.

- The AI may fill only the buyer's own request fields: quantity, delivery date, budget and
  a short description. It never sets maker availability, material dates, prices, payment
  terms or anything else; code accepts only those fields.
- **Grounding, field by field.** The AI must quote the buyer's words for each value. A
  value is shown as "from your words" only when its own quote is in the text and contains
  it. Further conditions apply:
  - a quantity's quote is not a money phrase, and the number isn't one end of a range;
  - measurements cannot supply a missing quantity, and competing quantities stay flagged;
  - a budget's quote names the same currency and agrees on per-piece versus total basis;
  - delivery dates retain their context: an event or dispatch date is not a delivery
    deadline, alternatives remain flagged, and "before D" means the preceding day.

  Swapped fields, ranges ("50–60"), dates the buyer didn't write explicitly, and unquoted
  or mismatched currencies stay "please check". A non-dollar, non-rupee budget is left
  empty with a question. Missing values stay empty, with a question.
- A request outside the collective's product is flagged for the buyer to correct.
- The public page is `/c/request`. A buyer's agent uses the MCP tool
  `request_collective_order` with the requirements its user confirmed; it can read status
  with `get_collective_order`. Agents can neither approve terms nor pay: the human does
  both on the returned link.
- The interpretation and the buyer's corrections are kept with the order
  (`collective_orders.intake`) for evaluation.
- **Claim boundary:** we describe Agentic Commerce as delivered only after a recorded
  run in which a real agent makes the request.

## B. Individual versus collective

The planner and checker are run for each maker alone and for the group, on the same
facts, reservations, deadline and cost assumptions.

- **Coordinator:** each maker's standalone result (most pieces by the date, or the
  lowest price compared with the budget) with its checker verdict.
- **Buyer and agents:** only the aggregate sentence, and only when every standalone
  answer is a checked refusal and the group answer is a checked yes:
  "No individual maker can fulfil this request within its date and budget. The
  collective can." No names, capacities or individual prices.

## C. One unknown materials date: the deciding threshold (model extension M1-Q1)

Scope: exactly one maker's materials-ready date is unknown and every other required fact
is known, current and consistent. With several unknowns, Haat keeps the honest list of
unresolved facts.

- Under M1 a later materials date never adds a feasible plan, so feasibility within the
  budget is monotone in that date. Haat finds the latest date that still works.
- The answer is one of:
  - "If her materials are ready by *D*, the order works; from *D+1* it does not", with a
    checked plan at *D* and the matching checked refusal at *D+1*: a capacity cut, or a
    certified minimum price above the budget;
  - "Even if her materials were ready on the first day, the order does not work", with
    that refusal checked at the first day;
  - not applicable.
- Hypothetical dates are used only inside the calculation, marked `system`/hypothetical,
  and are never stored as facts. The main M1 answer stays "unresolved" until she states
  the date.
- Contract: [planner-model.md §8](planner-model.md). Earlier evaluation results remain
  labelled M1; M1-Q1 results are reported separately.

## D. Replanning that preserves agreements

When a plan must change, the coordinator can ask for a plan that keeps agreed parts.

- **Objective:** first, keep the greatest number of complete, identical accepted parts:
  same days, pieces, pay, finishing end and dispatch date, the same terms hash. Second,
  among plans keeping equally many, the lowest price. Every current constraint and the
  buyer's budget apply.
- **Search:** every subset of accepted parts is tried, largest first, when there are at
  most 8. Beyond that a greedy search is used and the result is labelled *heuristic*.
- **Checked:** the plan passes the independent checker, and every kept part's terms hash
  equals the accepted one. **Exhaustive search, not independently certified:** that no
  larger set can be kept. The record lists why each larger set failed.
- The coordinator sees the cost of keeping agreements against the cheapest fresh plan,
  for example "keeping 2 agreed parts costs $4.20 more than the cheapest fresh plan".

---

## Claims we make and do not make

| Say | Do not say |
|---|---|
| Checked against the facts recorded for the makers | Checked against what they can really do |
| Each maker agrees on her personal link | Only the maker can agree |
| Changed terms need renewed approval from the buyer and the makers whose parts changed | Any change means everyone approves again |
| PayPal receives the buyer's payment; makers are paid outside Haat and confirm receipt | PayPal settles with the makers |
| On 46 synthetic cases, the planner and the improved rule both made no unsafe promises; the planner found one more feasible order | The planner is far better than a coordinator |
| Sandbox: a real PayPal capture; the maker payout used a test reference; the maker was role-played | A maker received income through Haat |
| Fee estimate: PayPal's published rate plus a labelled buffer, to be verified per account | 4.65% is PayPal's fee |
