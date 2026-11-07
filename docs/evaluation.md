# Evaluation

Two parts:

1. A **comparative evaluation** on synthetic cases. Four ways of answering a collective
   order are given the same facts and the same requests, and every answer is judged by
   the same independent checker.
2. **One complete transaction**, run through the whole system with PayPal sandbox money.
   It goes from buyer request to plan, maker consent, buyer approval, PayPal payment,
   payment to a maker, and her confirmation.

A separate **role-play evaluation** with people in the coordinator, maker and buyer roles
is described in [role-play-kit.md](role-play-kit.md). It is not a pilot. Its results
will be reported separately, with the number of participants.

## 1. Comparative evaluation

### Method

- **Cases.** There are 46 cases:
  - 6 hand-written, one for each failure mode a coordinator worries about;
  - 40 generated from a recorded seed (`20261108`).

  The generated cases are drawn until each true answer has a quota: 16 "yes", 12
  "can't, not enough capacity", 6 "can't, not within the budget" and 6 "can't decide
  yet: a needed fact is unknown".

  Each case is a collective of 2–4 makers, with varying:
  - capacity per weekday;
  - materials dates (sometimes unknown);
  - other promises, with or without due dates;
  - caps and asking prices;
  - a shared finishing table.

  Requests vary in quantity, date and sometimes budget. The horizon, rest day, packing,
  transit, costs and fees are fixed, and match the demo collective. The code is in
  `eval/scenarios.ts`.
- **Truth.** The true answer for each case is model M1's answer
  ([planner-model.md](planner-model.md)), used only after the independent checker
  (`src/lib/planner/check.ts`) accepts it. The checker shares no code with the solver.
  The planner is also tested against an exhaustive reference on small instances
  (`tests/planner-oracle.test.ts`). The planner's own column is therefore a consistency
  check, not evidence.
- **The approaches** (`eval/approaches.ts`, `eval/llm.ts`):
  - **Rule-based split** — the competent baseline, i.e. what a careful coordinator does
    in a spreadsheet:
    - each maker's own promises go on her earliest days;
    - makers are filled cheapest first, each on her earliest free days, up to her cap;
    - if that misses the date, the split is redone earliest available first;
    - finishing is first-in, first-out, after the rest day;
    - makers with an unknown materials date are not counted on.
  - **Old Haat** — the single-maker quote rule Haat used before the planner
    (`src/lib/custom/quote.ts`): weekly rate minus promised work, over the days before
    the deadline less courier days. It can't combine makers, and it doesn't see the
    finishing table, weekday patterns, materials dates or promise due dates. It is priced
    by the same cost-plus rule as the others.
  - **AI model, direct** — one model, given the rules in plain words and the same facts
    as JSON, with no tools and no solver. It must return the decision, a day-by-day
    schedule and the price. The model is fixed (no fallback to another model), the
    temperature is 0, and the prompt is saved in the results.
  - **Planner** — model M1.
- **Scoring** (`eval/score.ts`). Each answer is placed in exactly one bucket:
  - right yes;
  - **unsafe promise**: a yes whose schedule the checker rejects, a one-maker claim that
    maker can't deliver, or a yes over the buyer's budget;
  - missed order;
  - right no;
  - **wrong kind of no**, e.g. "impossible" when the honest answer is "not decided yet",
    or capacity confused with budget;
  - right "can't decide yet";
  - unsupported;
  - no answer.

  **Unsupported** cases are reported separately: old Haat can't combine makers, and it
  has no way to say "not decided yet". They are not counted as mistakes. For valid yeses,
  the price is compared with the certified cheapest price. For capacity refusals, the
  "most we can do" figure is compared with the true maximum.

### Results: deterministic approaches, all 46 cases

From `eval/results/seed-20261108.md` (re-run with `npm run eval -- --no-llm`; deterministic):

| | Planner | Rule-based split | Old Haat (one maker) |
|---|---|---|---|
| Right decision | 46/46 | 38/46 | 29/38 answered |
| **Unsafe promises** | 0 | 0 | **8** |
| Orders missed | 0 | 1 | 0 |
| Wrong kind of no | 0 | 7 | 1 |
| Unsupported (separate) | 0 | 0 | 8 |
| Price above the cheapest (median / worst) | 0% / 0% | 0% / 0% | 0% / 5.3% |
| "Most we can do" exact | 14/14 | 13/14 | 0/12 |

**What this shows, without overstating it:**

- **The competent rule-based split is strong.** It made **no unsafe promises**, and
  when it found a plan, its price was the cheapest possible.
- **Where it falls short:**
  - In all 7 cases where the honest answer is "can't decide yet", it says a flat
    "no". Telling a buyer an order is impossible when it really depends on one maker's
    materials date loses orders the collective could take.
  - It missed one feasible order (case r12). It offered 50 when 51 fit, because its
    fill order wastes finishing-table days.
- **Old Haat over-promised in 8 of 46 cases.** Four were promises one maker can't keep
  once the finishing table, her weekday pattern or her promise due dates are counted
  (e.g. case h1, where the finishing table is the limit). Four relied on facts that
  were unknown. It also can't combine makers at all: 3 feasible orders were out of its
  reach.
- **The planner's advantage over a careful manual method is narrower than over old
  Haat.** It comes from:
  - separating the kinds of "no";
  - finding plans heuristics miss;
  - exact "most we can do" figures;
  - every answer carrying a certificate that a separate checker verifies.

  It is not about avoiding unsafe promises that a careful person would also avoid.

### Results: the AI model (pending)

The AI-direct baseline needs about one model call per case, and each call took 1–3
minutes. On 7 November, the free Gemini tier's daily quota for `gemini-3.6-flash` and
`gemini-3.5-flash` ran out after roughly 20 requests. That figure is our estimate; the
exact quota isn't shown to us. Among those were silent retries inside the AI library,
which are now switched off.

The run was stopped, and its partial answers were not used. The 9 answers it got:
- 6 were right;
- 1 unsafe promise;
- 1 missed order;
- 1 wrong kind of no.

Too few to report.

**Plan.** The AI model will answer a fixed **18-case subset**: all 6 hand-written cases,
plus the first generated cases of each answer type (4 yes, 3 capacity, 2 budget, 3
undecided). All four approaches are scored on exactly those cases. Answers are saved one
by one, so a run stopped by the quota resumes later. Run after the daily reset (midnight
Pacific, 13:30 IST):

```
npm run eval
```

To leave the app's own quota untouched, set `EVAL_GOOGLE_API_KEY` to a separate key (and
optionally `EVAL_MODEL`). The results will be added here, whatever they show.

### Limits

- **The cases are synthetic.** They are shaped like the demo collective, but they are
  not real collectives' data.
- **Truth comes from model M1.** Anything M1 doesn't model, the evaluation doesn't
  measure either: per-maker fixed costs, quality differences between makers, travel,
  and so on.
- **The rule-based baseline is one reasonable heuristic,** not the best a skilled
  person could do with unlimited time. The role-play's manual round tests that against
  a person instead.
- **The AI result will hold for that model, that prompt and that date.** Better
  prompting or tool use could change it.

## 2. One complete transaction (PayPal sandbox)

Run on 7 November 2026 on the local server (`collective` branch, migrations to `0019`),
with the PayPal sandbox.

| Step | Who | Evidence |
|---|---|---|
| Lena (Berlin shop) asks for 30 indigo scarves, delivered in 24 days; Hindi requirement "नीला रंग" | Coordinator | Order `ddc9074a-…` |
| The planner's answer, independently checked: feasible, $236.86 | Planner + checker | Sunita 20, Meera 10 |
| Each maker accepts her own part on her own link | Makers (played by the developer for this test) | Parts accepted, `personal_link`, on their hashes |
| The buyer approves the exact terms; capacity is reserved | Buyer (the project owner, on the sandbox) | Hold ends at the start of the first work day |
| The buyer pays the collective (merchant of record) with a PayPal sandbox account | Buyer | PayPal order `27950607240336111`, capture `6XH61035R53768108`, **$236.86 COMPLETED** |
| Haat records PayPal's own numbers; the plan is paid; each share is created once | System | Fee **$11.26** (estimate was $10.72); net $225.60; Sunita owed ₹7,600, Meera owed ₹4,200 |
| The coordinator records a UPI payment of ₹4,200 to Meera (a test reference; no real transfer) | Coordinator | Status "reported", not counted as paid |
| Meera confirms on her link that she received it | Meera (played by the project owner) | Status "confirmed", share settled |
| Attempts to undo it are refused | — | Coordinator withdrawal: refused (409). Meera disputing after confirming: refused (409). Sunita's link on Meera's payment: not found (404). |
| The buyer's page shows nothing about payouts | — | No maker names, ₹ amounts or references in the buyer view |

**Notes:**

- **The fee estimate is low.** PayPal's actual fee on this sandbox account ($11.26,
  about 4.75%) was higher than the collective's fee setting (4.4% + 30¢ = $10.72). The
  collective would net about ₹47 less than planned on this order. The fee setting should
  be raised before real use. Haat already shows the actual fee next to the estimate.
- **Webhooks.** The payment was captured on PayPal's return to the order page. Webhooks
  can't reach a local server, so that path was not part of this run. It is covered by
  tests.
- **Still owed.** Sunita's ₹7,600 remains owed and unreported. That is the correct
  state: no payment to her was recorded.

## Reproducing

```
npm run eval -- --no-llm          # deterministic part (identical every run)
npm run eval                      # adds the AI model on the 18-case subset (needs a Gemini key)
npx tsx --test tests/eval-harness.test.ts
```

Every case, answer, score and raw model output is written to
`eval/results/seed-20261108.json`.
