# Collective orders: allocation, consent and reservations

This document is the contract for `src/lib/collective/`. The planner it calls is model M1
([planner-model.md](planner-model.md)). Every rule below is enforced in code and tested
in `tests/collective.test.mts`, `tests/collective-integrity.test.mts` and
`tests/collective-checkout.test.mts`. For each rule, the tests deliberately break it once and
check that a test fails.

## Facts

- **The collective's settings:** product, shared finishing capacity per weekday, lag,
  packing and transit days, per-piece costs, fee estimate, exchange rate and horizon. These
  are entered by the coordinator, with provenance.
- **Each maker's facts:**
  - whether she makes the product
  - pieces per weekday and days off
  - the calendar date when her materials are in hand (unknown is allowed)
  - her other promises
  - her asking price, and her private minimum (never shown to buyers or other makers)
  - an optional cap on pieces
- Each record carries its provenance:
  - **Confirmed by her** on her personal link.
  - **Entered by the coordinator.** The planner uses these but labels the answer an
    *estimate*. Her own confirmation replaces them.
- `buildFacts` is the single conversion from stored facts into M1 facts for one start
  date.
  - **Materials keep their date.** Legacy "in N days" records are anchored to the date
    she stated them, not to the plan's start. Confirming or editing unrelated facts
    preserves that date. Changing a legacy delay anchors the new delay to the edit date.
  - **Plans start the day after they are made.** Nobody is asked for work on a day already
    under way. Days are India's calendar dates (IST, UTC+5:30). Just after midnight in
    India, "today" is already the new date, even while it is still yesterday in UTC.
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
   - The terms are bilingual. Her read-back is generated from them. Custom requirements
     have separate English and Hindi readings, both inside her fingerprinted terms.
     The coordinator enters and reviews both; the app does not verify translation accuracy.
     English-only drafts may be saved, but cannot be offered. Legacy parts missing Hindi
     requirements cannot be accepted or used for buyer approval.
   - The coordinator can correct both readings before payment. This releases unpaid
     reservations and requires a new plan. Old parts keep their original words; a changed
     reading changes the hash and requires each affected maker to accept again.
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
   - Fact edits take the same collective lock as approval. Meaningful changes invalidate
     every affected unpaid plan and release its hold atomically. If an approval is already
     running, the edit waits and then invalidates it; if the edit runs first, approval waits
     and refuses the old version. Confirming unchanged facts preserves existing holds.
     Edits affecting a payment in progress are refused. Paid plans remain frozen.
2. **A hold counts while it is approved and unexpired, paying, or paid.** An unpaid hold
   ends 48 hours after approval, or when the plan's first work day starts if that is
   sooner: makers start only once the buyer has paid. An unpaid hold lapses. Capacity is released, the makers' acceptances stand, and the buyer
   approves again, which re-checks. Expiry compares the exact hold timestamp it read, so
   a stale expiry reader cannot clear a renewed approval.
3. **An order's own hold is never counted against it** when the coordinator re-plans it.
4. **Transaction lock order:** collective, then order, then plans, then parts. The
   single-row expiry update instead uses a conditional update against the exact old hold.

## Payment: the collective sells, and pays each maker

The collective is the seller (merchant of record). The buyer pays the collective through
PayPal for one exact plan version. The collective then owes each maker her accepted
part's pay. Code: `src/lib/collective/checkout.ts` and `src/lib/collective/payouts.ts`.

1. **Opening checkout.** A PayPal order is created only when all of these hold:
   - the plan is the current version, approved by the buyer on its hash;
   - its hold is unexpired and capacity is reserved;
   - every referenced part is still accepted on her link on its exact hash;
   - no work day in the plan has started.

   The amount comes from the frozen buyer terms. The PayPal order carries the plan id.
   Haat's order row records the plan id, its terms hash and the amount, and has no
   shop. The PayPal request id is derived from the plan and its hash, so a retry or a
   double click reuses the same PayPal order.
2. **Every capture path checks again first.** The browser return, the webhook and
   retries all lock the order tree and repeat every condition above. They also check
   that the payment's hash and amount match the plan. Only then do they mark the plan
   `paying`. While a plan is paying, these are all refused:
   - re-planning;
   - a maker declining or withdrawing;
   - editing the facts of a maker in it;
   - changing the requirements;
   - a second payment for the same plan.

   A refusal happens before PayPal is asked to capture, so the buyer is not charged.
3. **Outcomes come from PayPal's capture record**, through the same finaliser as every
   other Haat payment:
   - **Completed:** the plan is `paid`, its reservation is kept, and each maker's share
     is created exactly once from her accepted part (id, hash, pay).
   - **Definite refusal:** the plan goes back to `approved`.
   - **Unknown outcome:** the plan stays `paying`. After 10 minutes it is reconciled
     against PayPal's own order record. Anything ambiguous stays `paying`.
   - **A second capture for terms already paid** is never counted. The first payment
     stands, and the plan is flagged for a refund.
   - **Paid while not marked paying.** This should not occur, because every capture
     path marks the plan paying first. If it does, the paid terms win, and the plan
     carries a note for the coordinator to review.
4. **Maker payouts have three states that stay distinct:**
   - **Owed:** her share, created when the buyer's payment is captured. Nothing else
     creates or changes it.
   - **Reported:** the coordinator records an amount with its UPI reference (12 digits)
     or bank UTR (12–22 characters). A reported payment is a claim, not a payment.
   - **Confirmed:** she says she received it, on her own link. Only she can do this,
     and it is final.

   She can instead say it didn't arrive (`disputed`). A disputed payment never counts
   as paid, but it keeps occupying her share until the coordinator withdraws it.

   **Limits:**
   - Reported, disputed and confirmed amounts together never exceed what she is owed.
   - A reference is used once per collective.
   - The coordinator can withdraw any record she hasn't confirmed.
   - Haat does not read bank or UPI records. "Confirmed" means confirmed by her, not
     verified with a bank.
5. **Who sees the money.**
   - **The coordinator:** PayPal's own capture id, fee and net next to the estimate,
     and every share and payment.
   - **Each maker:** whether the buyer has paid ("start" or "don't start yet"), her
     share and her payments.
   - **The buyer:** only that the order is paid, and when.

## Who sees what

| View | Sees |
|---|---|
| Coordinator (studio sign-in) | Every maker's facts with provenance, the checked answer and alternatives, the plan grid, money breakdown, each part's status and how it was answered, version history, PayPal's payment record, every maker's share and payments. |
| Maker (her link) | Her parts only: read-back in Hindi, pay, days, dependency dates; her own facts; whether the buyer has paid; her share and the payments reported to her. Never another maker's name, pay or schedule. |
| Buyer (order link) | Quantity, product, total, dispatch and delivery dates, how the terms differ from the request, how many makers confirmed, payment status. No maker's name, pay, minimum, availability, promises or payouts. |

## Not in this version

- **Changes after payment.** This covers refunds, a maker who can't finish, and
  re-planning a paid order. A refund that PayPal reports is shown to the coordinator,
  but makers' shares are not adjusted.
- **Shipping and tracking** for collective orders.
- **Per-maker fixed costs** (unsupported in M1).
- **Voice entry of facts.** Facts are typed on her page; parts are read aloud to her.
- **Testing limits:**
  - The tests default to embedded Postgres, which serialises transactions. To use an
    isolated disposable PostgreSQL database, set `COLLECTIVE_TEST_DATABASE_URL` and run
    `node --import tsx --test --test-concurrency=1 tests/collective.test.mts tests/collective-integrity.test.mts`.
    Sequential file startup avoids competing startup migrations; races within each file
    still use concurrent connections.
  - Forced race tests also run on local PostgreSQL 18. They observe actual server lock
    waits for both fact-edit/approval directions, and force a stale expiry read across
    a renewal. These are targeted concurrency checks, not a Neon load test.
