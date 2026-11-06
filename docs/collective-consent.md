# Collective orders: allocation, consent and reservations

This document is the contract for `src/lib/collective/`. The planner it calls is model M1
([planner-model.md](planner-model.md)). Every rule below is enforced in code and tested
in `tests/collective.test.mts`. For each rule, the tests deliberately break it once and
check that a test fails.

## Facts

- **The collective's settings:** product, shared finishing capacity per weekday, lag,
  packing and transit days, per-piece costs, fee estimate, exchange rate and horizon. These
  are entered by the coordinator, with provenance.
- **Each maker's facts:**
  - whether she makes the product
  - pieces per weekday and days off
  - days until her materials are in hand
  - her other promises
  - her asking price, and her private minimum (never shown to buyers or other makers)
  - an optional cap on pieces
- Each record carries its provenance:
  - **Confirmed by her** on her personal link.
  - **Entered by the coordinator.** The planner uses these but labels the answer an
    *estimate*. Her own confirmation replaces them.
- `buildFacts` is the single conversion from stored facts into M1 facts for one start
  date.
  - **Plans start the day after they are made.** Nobody is asked for work on a day already
    under way.
  - **Past-due promises** are treated as due on the first day. If they no longer fit, she
    is asked to re-confirm.

## Plans, parts and versions

1. **The checker gates every offer.** A plan is offered only after the planner's whole
   answer passes `checkEvaluation`, and the chosen plan passes `checkPlan`. The plan can be
   the primary answer or a stated alternative: lowest price, most within budget, most by
   the date, or earliest date.
2. **Each maker's part is immutable terms plus a SHA-256 hash.**
   - Her terms are: her pieces per day, her pay, and the shared dates her part depends on
     (finishing end, dispatch).
   - The terms are bilingual. Her read-back is generated from them.
3. **The overall plan is versioned.**
   - Its terms are the buyer's terms plus a reference (`partId`, `termsHash`) to every
     part, and its own hash covers both.
   - Any change to anyone's part therefore produces a new plan version.
4. **Re-asking.**
   - A new plan version reuses a maker's part, and her earlier answer, only when her terms
     hash is identical.
   - A changed part is a new version (`v2`, …) that she must accept again. The old version
     is superseded and can no longer be answered.
   - A maker no longer needed sees "your part is no longer needed".

## Consent

- **Only her own response counts:**
  - It must arrive through her personal link, for exactly the hash she was shown.
  - There is no coordinator path that accepts on her behalf.
  - A row marked accepted by any other channel does not satisfy the approval gate.
- **Link possession is not identity.**
  - The link is a 192-bit random token. Only its hash is stored.
  - It is shown once, when the coordinator issues it, and issuing a new link revokes the
    old one.
  - Answers are recorded as `personal_link`, never as "verified".
- **Saying no.**
  - She may decline, or withdraw an acceptance until payment starts.
  - Declining moves the plan to `maker_declined` and releases any held capacity.
  - She is never silently replaced. Leaving her out of the next plan is an explicit,
    recorded coordinator step, allowed only after she declined. The new plan then goes
    through consent and buyer approval again.

## Reservations

1. **Approval is atomic.** The buyer approves inside one transaction, under a lock on
   the collective's row. That transaction:
   - requires the current plan version and its exact terms hash;
   - re-reads every referenced part (each accepted, on her link, on its hash);
   - re-checks the exact plan with `checkPlan` against the facts as they are now,
     including other orders' holds, makers' current facts and the collective's current
     settings;
   - refuses a plan whose first work day has already started;
   - only then writes the reservation.

   **Consequences:**
   - Two orders cannot both reserve the same finishing or maker capacity. Whichever buyer
     approves second is refused, and that plan is marked `needs_replan`.
   - A fact that changed after the makers accepted (lower capacity, a new price) is caught
     here, and nothing is reserved.
2. **A hold counts while it is approved and within 48 hours, paying, or paid.** An unpaid
   hold lapses. Capacity is released, the makers' acceptances stand, and the buyer
   approves again, which re-checks.
3. **An order's own hold is never counted against it** when the coordinator re-plans it.
4. **Lock order everywhere:** collective, then order, then plans, then parts.

## Who sees what

| View | Sees |
|---|---|
| Coordinator (studio sign-in) | Every maker's facts with provenance, the checked answer and alternatives, the plan grid, money breakdown, each part's status and how it was answered, version history. |
| Maker (her link) | Her parts only: read-back in Hindi, pay, days, dependency dates; her own facts. Never another maker's name, pay or schedule. |
| Buyer (order link) | Quantity, product, total, dispatch and delivery dates, how the terms differ from the request, how many makers confirmed. No maker's name, pay, minimum, availability or promises. |

## Not in this version

- **Payment is step 5.** The collective is the merchant of record; maker shares are
  recorded as owed, then reported with a reference, then confirmed by her.
- **Changes after payment.**
- **Per-maker fixed costs** (unsupported in M1).
- **Voice entry of facts.** Facts are typed on her page; parts are read aloud to her.
- **Testing limits:**
  - The tests run against embedded Postgres, which serialises transactions. They verify
    the re-check logic.
  - Row locking under concurrent connections relies on Postgres `SELECT … FOR UPDATE` and
    has not been load-tested on Neon.
