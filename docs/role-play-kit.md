# Role-play evaluation kit

This is a **role-play evaluation, not a pilot**. Participants play a coordinator, makers
and a buyer, using sandbox money and made-up facts. It tests three things:

- whether people understand what Haat shows them;
- whether makers feel able to say no;
- whether the coordinator reaches a sound decision faster or more safely than with a
  careful manual method.

It doesn't show real-world impact. Report it under that name, and give the number of
participants.

## Before the session

- **Setup:** the app runs locally (`npm run dev`) or at the deployed URL. Use the
  submitted commit, with all checked-in migrations applied (currently through `0021`).
- **Use isolated session data.** Preserve the paid sandbox order and its redacted
  receipt/ledger evidence. Stop the existing dev server, then use a fresh embedded
  database for each session, for example:
  `DATABASE_URL='' PGLITE_DIR=.data/role-play-session-01 npm run dev`.
  This keeps the original database intact. Do not use `demo:reset` on the evidence database.
- **Confirm facts before comparing.** Makers review and confirm their own facts and
  absolute materials dates before either timed round. Existing stored dates do not
  move forward automatically when the session date changes. The cards below are an
  example; the exported scenario's dated facts control the actual task.
- **Coordinator:** signs in at `/seller/login` with the studio PIN and opens
  **समूह · Collective orders**.
- **Maker links:** for each maker, press **New personal link**. Each link appears once
  and opens only her page; issuing a new link stops the old one working. Give each maker
  only her own link.
- **Buyer link:** each order's page has a **Copy buyer link** button.
- **Devices:** makers use phones if possible (their page is designed for phones and is
  Hindi first). The coordinator uses a laptop.
- **Consent:** read this aloud to participants:
  - this is role-play;
  - no real money moves, and payment is PayPal sandbox;
  - no personal data is needed (use the role names);
  - they can stop at any time.

## Roles

| Role | Played by | What they have |
|---|---|---|
| Coordinator (Kavita) | 1 person | Studio sign-in; the **facts sheet** below for the manual round |
| Makers (Meera, Sunita, Rukhsana) | 1–3 people, ideally Hindi speakers | Their own link; their own **maker card** only |
| Buyer (Lena, a shop in Berlin) | 1 person | The buyer link; a PayPal sandbox buyer account for task 5 |
| Observer | You | The recording form; a timer |

## Facts sheet (the same facts Haat uses)

**Shared:**
- Finishing table: 8 pieces a day Monday–Friday, 4 on Saturday, none on Sunday.
- A piece rests 1 day before finishing.
- Packing takes 1 day and courier transit 7 days.
- **Costs:**
  - per piece: finishing ₹40, packaging ₹30, collection ₹15, collective's charge ₹45;
  - per order: shipping ₹4,200;
  - PayPal fee: 4.4% + $0.30;
  - exchange rate: ₹88 to the dollar.

**Maker cards** (give each maker only her own):

| Maker | Pieces a day | Materials | Other work | Asking price | Minimum (private) | Cap |
|---|---|---|---|---|---|---|
| Meera | 3 Mon–Fri, 2 Sat | in hand | 6 pieces promised to her own shop | ₹420 | ₹360 | — |
| Sunita | 2 Mon–Fri | in 3 days | — | ₹380 | ₹340 | 20 pieces |
| Rukhsana | 4 Mon, Tue, Wed, Fri, Sat | in 2 days | — | ₹450 | ₹400 | — |

## Design: freeze the same inputs for both rounds

Run each planning task once manually and once with Haat. Alternate the order between
sessions and record it. Repeating the same task creates learning effects even with
counterbalancing; report that limit. Task 5 tests workflow/comprehension, not a manual
optimisation benchmark.

Before each paired task, the **observer** sets up the task's starting state, including
price changes, other orders' holds or an explicit maker exclusion. Do not change these
between the manual and Haat rounds. For a new task, export a new scenario.

1. In the coordinator order detail, open **Role-play evaluation → Download evaluation
   facts**. Save as `before.json`. Only the observer handles the studio at this point:
   its page already contains Haat's answer, which the manual-first participant must not
   see. The export contains facts and fingerprints, no planner answer, and includes
   private maker facts. Keep the raw file with the observer.
2. Generate the manual facts sheet without revealing a solution:

   ```
   npx tsx eval/check-split.ts before.json --sheet > facts.txt
   npx tsx eval/check-split.ts before.json --template > split.json
   ```

   Give the coordinator the sheet and paper/spreadsheet, with 15 minutes. The sheet
   includes dated capacities, materials, costs, existing promises and reservations.
   Give makers only their own cards. They may answer:
   - yes: production/finishing dates and **their own USD price**;
   - no capacity: the most they think can fit;
   - no budget: the minimum price they think is needed;
   - cannot decide: what fact needs confirmation.

3. Seal/record the manual answer before running its checker. For a yes, fill the
   template with `priceUsdCents` (e.g. 23686 means $236.86), production entries
   `{ "maker": "<id or unique name>", "date": "YYYY-MM-DD", "pieces": 3 }`, and
   finishing entries `{ "date": "YYYY-MM-DD", "pieces": 8 }`. A null price is an
   unfinished template and is rejected. For other decisions use:

   ```json
   { "scenarioFingerprint": "<copy from before.json>", "decision": "no_capacity", "maxQuantityByDate": 14 }
   ```

   Or `decision: "no_budget", priceUsdCents: ...`, or
   `decision: "cannot_decide", reason: "..."`. Keep the fingerprint in every answer.
   Do not run the checker until the manual answer is recorded: it prints Haat's result
   as well, which would otherwise reveal the solution.
4. Run the Haat round on the same starting state. Afterwards refresh the coordinator
   page and download **another** evaluation export as `after.json`. Then run:

   ```
   npx tsx eval/check-split.ts before.json split.json --compare after.json
   ```

   This checks the manual answer against the **original saved facts**, and verifies
   that Haat's displayed evaluation used the same facts/request. If the inputs differ,
   do not report a paired comparison: repeat both rounds on a new snapshot. This works
   for refusals and alternatives too; it checks the original request's evaluation,
   rather than confusing a smaller offered alternative with that request.

The JSON result separates decision/schedule correctness, quoted-price correctness and
maximum-quantity accuracy. `valid` requires all applicable parts to be correct. Exit
code 0 means valid, 1 means an incorrect answer, 2 means invalid files or mismatched
comparison inputs. The checker uses the snapshot's own timestamp, not a fixed demo date.

## Fairness of the manual round

The exported facts are the source for both rounds. Do not rebuild the manual round
from the illustrative cards: that would drop current prices, declined makers and other
orders' reservations. Do not give the manual participant Haat's answer, minimum-price
result or manual-checker feedback before recording her answer. A session that runs
across a change of planning day may need to be repeated.

## Tasks

Delivery dates below are relative prompts. Record actual dates in the app and on the
exported sheet. These are tasks to observe, not predetermined outcomes; actual available
capacity depends on the session date and reservations.

1. **A big order.**
   - Lena asks for 60 indigo scarves, delivered in 24 days.
   - The coordinator records it (Hindi requirement: "नीला रंग") and sends a plan.
   - Each maker listens to her part (🔊) and accepts or declines.
   - Lena approves.
2. **A maker changes her price.**
   - After task 1's plan is sent, Rukhsana raises her asking price by ₹30 on her own page.
   - The coordinator sends a new plan.
   - Start this paired task **after** the price edit. Export its changed facts before
     either round. Re-approve the revised plan before task 3.
   - *Check:* changed parts need renewed consent; unchanged parts retain it. If an
     allocation or shared date changes, more than one part may legitimately change.
3. **A competing order.**
   - With task 1 approved, a second buyer asks for 50 scarves by the same date.
   - Export the second order's facts **with the first reservation active** for both
     rounds. Do not use an empty-reservation checker.
   - *Check:* if it cannot fit, does the coordinator see "No", with the most that fits? Can she offer that
     smaller order, or the earliest date for all 50?
4. **A maker says no.**
   - In a fresh order, one maker declines her part, with a reason.
   - The coordinator chooses whether to leave her out and re-plan.
   - For a planning comparison, export the new starting state after the explicit
     exclusion, and use it for both rounds. Record the decline/consent flow separately.
   - *Check:* is anyone replaced without a new plan that the buyer approves?
5. **Payment and payout.**
   - Lena pays with the PayPal sandbox buyer.
   - The coordinator records a UPI payment to one maker.
   - That maker confirms it on her link. A second maker disputes a payment instead.
   - *Check:* does each maker see "don't start" before payment and "start" after? Is the
     disputed payment visibly not counted as paid?

## Questions for makers (after each part they answer)

Ask in Hindi, without looking at the screen together:

1. "आपको कितने पीस, किन दिनों में बनाने हैं?" (How many pieces, on which days?)
2. "आपको कुल कितने पैसे मिलेंगे, और कब?" (How much will you be paid in all, and when?)
3. "आप काम कब शुरू करेंगी?" (When will you start?) The right answer is: only after the
   page says the buyer has paid.
4. "अगर आप यह काम न कर पाएँ, तो क्या कर सकती हैं?" (If you can't do it, what can you
   do?) The right answer is: say no, or withdraw before payment.
5. "क्या आपको लगा कि आप मना कर सकती हैं?" (Did you feel you could say no?) Answer
   1–5.

## Questions for the buyer

1. What exactly are you paying for? (Quantity, total, dispatch date, delivery estimate.)
2. Did anything differ from your request, and where did you see it?
3. Who are you paying, and who pays the makers?

## Recording form (one row per task per method)

| Session + scenario fingerprint | Task | Method (manual / Haat) | Order (1st / 2nd) | Minutes to a decision | Decision | Schedule valid? / price correct? / maximum exact? | If "no": kind right? | Maker answers right (of 4) | Felt able to say no (1–5) | Buyer understood (of 3) | Confusions / quotes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | | |

**Report:**
- **Per method:** decisions/schedules accepted, complete answers accepted (including
  the participant's price/maximum), unsafe schedules, refusal-category differences
  from M1 and median minutes. Keep errors/timeouts, uncompleted tasks and input-mismatch
  exclusions visible. Do not describe a valid schedule with a wrong quote as fully correct.
- **Per question:** how many people answered correctly.
- **Quotes:** verbatim, including critical ones.

With a handful of participants, present counts, not percentages, and make no claims of
statistical significance.

## After the session

- Use a new isolated database directory for the next session.
- Keep both snapshots, sealed manual answers, checker results and observation forms.
- The core sandbox transaction record remains separate from these role-play datasets.
