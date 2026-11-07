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
  - **Rule-based split** — one spreadsheet-style heuristic with basic uncertainty
    handling, rather than a claim to represent every skilled coordinator:
    - each maker's own promises go on her earliest days;
    - makers are filled cheapest first, each on her earliest free days, up to her cap;
    - if that misses the date, the split is redone earliest available first;
    - finishing is first-in, first-out, after the rest day;
    - makers with an unknown materials date are not counted on;
    - inconsistent existing promises trigger a request to confirm facts;
    - for an unknown materials date, a loose optimistic capacity bound can still prove
      a capacity refusal; otherwise the answer is "cannot decide yet". This wrapper
      uses no solver or optimality oracle. The allocation heuristic itself is unchanged.
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

  **Separate accuracy measures:** decision/schedule correctness uses the buckets above.
  A **complete answer** additionally needs the correct quoted price (including the
  claimed minimum on a budget refusal), minimum-price allocation where that minimum
  is certified, and an exact stated maximum on a capacity refusal. Price gaps are not
  computed against uncertified minima. A valid schedule quoted at $0.01 is not a completely correct answer.
  Missing model prices count as incorrect. Calculation of a schedule's true cost does
  not repair the answer's quoted price. Errors count as failures in the complete-answer
  denominator; unsupported cases remain separate.

  **Unsupported** cases are reported separately: old Haat can't combine makers, and it
  has no way to say "not decided yet". They are not counted as mistakes. For valid yeses,
  the price is compared with the certified cheapest price. For capacity refusals, the
  "most we can do" figure is compared with the true maximum.

### Results: deterministic approaches, all 46 cases

From `eval/results/seed-20261108.md` (re-run with `npm run eval -- --no-llm`; deterministic):

| | Planner | Rule-based split | Old Haat (one maker) |
|---|---|---|---|
| Decision/schedule correct (price separate) | 46/46 | 44/46 | 29/38 answered |
| Complete answer correct (quote / maximum included) | 46/46 | 43/46 | 13/38 |
| **Unsafe schedule promises** | 0 | 0 | **8** |
| Orders missed | 0 | 1 | 0 |
| Different refusal category from M1 | 0 | 1 | 1 |
| Unsupported (separate) | 0 | 0 | 8 |
| Calculated schedule cost above cheapest (median / worst) | 0% / 0% | 0% / 0% | 0% / 5.3% |
| "Most we can do" exact | 14/14 | 13/14 | 0/12 |

**What this shows, without overstating it:**

- The original heuristic in commit `4398681` scored 38/46. Seven disagreements were
  refusals where M1 asked for more information. Adding basic uncertainty/inconsistency
  handling raises the heuristic to **44/46**, without changing its allocation method.
  The old implementation remains available as `ruleBasedGreedy` for audit.
- **The stronger heuristic is strong:** no unsafe schedules on this suite, and the
  cheapest price whenever it found a plan. It missed one feasible order (`r12`): it
  found 50 pieces where 51 fit, due to its allocation order and finishing-table timing.
- Its remaining refusal-category disagreement (`r02`) is partly a **policy difference**:
  its loose optimistic bound proves the requested 80 cannot fit despite one unknown
  materials date. M1 requires complete facts before a capacity refusal with an exact
  maximum, and therefore returns "cannot decide yet". The classification metric is
  agreement with M1's policy, not independent proof that this refusal is unsafe.
- **Old Haat over-promised in 8 cases.** Four ignored constraints such as shared
  finishing or promise due dates; four depended on unknown/inconsistent facts. It
  cannot combine makers, making three feasible orders unsupported. Its complete-answer
  score also penalises inaccurate maxima and an inaccurate claimed minimum price.
- The demonstrated optimisation advantage over this strengthened heuristic is small
  on this suite. Do not claim a large real-world impact or a large advantage over a
  skilled coordinator. Verified schedules, exact boundary answers and consent/payment
  integrity are separate product benefits. The planner's 46/46 remains a consistency
  check against its own checked truth, not independent performance evidence.

### Results: the AI model (pending)

The AI-direct baseline needs about one model call per case, and each call took 1–3
minutes. On 7 November, the free Gemini tier's daily quota for `gemini-3.6-flash` and
`gemini-3.5-flash` ran out after roughly 20 requests. That figure is our estimate; the
exact quota isn't shown to us. Among those were silent retries inside the AI library,
which are now switched off. The review also found that a message regex accidentally
retried malformed output ("generated" matched "rate"). That application retry is now
removed from the default runner too.

The run was stopped, and its partial answers were not used. The 9 answers it got:
- 6 were right;
- 1 unsafe promise;
- 1 missed order;
- 1 wrong kind of no.

Too few to report.

**Plan.** The AI model will answer a fixed **18-case subset**: all 6 hand-written cases,
plus the first generated cases of each answer type (4 yes, 3 capacity, 2 budget, 3
undecided). All four approaches are scored on exactly those cases. Answers are saved atomically one
by one, with the exact model, full prompt, output schema, facts and request fingerprint.
Only identical inputs are reusable. Invalid answers remain recorded as errors on resume;
`--retry-errors` explicitly starts additional attempts and preserves their history, so
those results must be labelled as a rerun. Legacy unbound caches are not trusted.

The default is **one provider request per case**, with no SDK/application retries and
no model fallback. Any HTTP 429 stops the invocation immediately; it can mean a
per-minute or daily limit, so check AI Studio rather than assuming every 429 is daily.
The report records actual requests, valid responses, errors and pending cases separately.
Run when the project's applicable limit permits it. Daily quotas reset at midnight
Pacific (13:30 IST during November 2026):

```
npm run eval
```

Limits apply **per Google project, not per key**. To isolate the app's quota, use
`EVAL_GOOGLE_API_KEY` from a separate project with its own applicable limits (and
optionally `EVAL_MODEL`); another key in the app's project shares its quota. See
[Google's rate-limit documentation](https://ai.google.dev/gemini-api/docs/rate-limits).
The results will be added here, whatever they show. No AI comparison was run as part
of the review corrections; only offline stubs were used to verify the runner.

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
  collective nets **$0.54 = ₹47.52** less than estimated at ₹88/USD. Holding the 30¢
  fixed component constant, this one observation implies 4.6272% rather than 4.4%:
  a difference of about **0.227 percentage points**, not 0.35. This arithmetic is not
  a live-fee tariff: check the actual merchant account's pricing before real use.
  The configured fee was not silently changed from one sandbox observation. Haat
  already shows the actual fee next to the estimate.
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

Deterministic results are written to `eval/results/seed-20261108.json` and `.md`.
AI comparison reports use `seed-20261108-ai.json` and `.md`, so `--no-llm` cannot erase
an AI report. Fingerprinted raw answers and all recorded attempts are kept in
`eval/results/llm-cache-v2-seed-20261108-<model>.json`.

For role-play, download a private scenario from the coordinator page before each
paired task. The manual checker now requires that file, the participant's own price,
and an answer tied to its fingerprint; it does not recreate an empty-reservation demo.
See [the updated protocol](role-play-kit.md).

Submission deadline: **12 November 2026, 12:00 PST = 13 November, 01:30 IST**.
[Official schedule](https://paypalaihackathon.devpost.com/details/dates).
