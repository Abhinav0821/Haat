# Collective order planner — model M1

This document is the contract for `src/lib/planner/`. The solver (`solve.ts`) and the
independent checker (`check.ts`) both implement it; they share only the types and the
facts hash in `model.ts`, never each other's code.

The mathematics is established (maximum flow / minimum cut, minimum-cost flow, greedy
optimality over polymatroids). Haat's contribution is applying independently checkable
planning to voice-confirmed artisan constraints and keeping each maker's consent attached
through allocation, revision and payment. Every guarantee below is **about the recorded
model and its confirmed inputs** — not about whether the model matches the workshop, whether
a parcel arrives on time, or whether an entered cost is true.

## 1. What M1 represents

Time is whole days `0 … H−1` from the plan's start date (UTC). One request at a time.

**One product family.** Every unit of the requested specification:

- consumes exactly **one unit** of a maker's daily production capacity *for this
  specification* and exactly **one unit** of the collective's shared finishing capacity
  (finishing = inspection/finishing table, the single shared stage);
- is interchangeable with every other unit once produced.

If pieces in the request differ in effort or finishing needs, M1 cannot represent the
request; split it into separate requests or extend the model.

**Makers** (`m`), each with facts carrying provenance (`maker_confirmed`,
`coordinator_entered`, …, with a timestamp):

| Fact | Meaning |
|---|---|
| `capable` | She confirmed she can make *this* specification. `false` → not considered. |
| `dailyCapacity[t]` | Pieces of this specification she can make on day `t` (0 = unavailable). |
| `materialsReadyDay` | First day materials for this order are in hand. Unknown → **unresolved**, never "impossible". |
| `commitments` | Her other promises: `pieces`, `dueDay`. These use her capacity, not shared finishing. Undated promises are treated as due first-in-first-out on her earliest capacity (stated as an assumption). |
| `askInrPerPiece` | What she asks to be paid per piece for this work. |
| `floorInrPerPiece` | Her private minimum. Must be ≤ ask; never shown to buyers. |
| `maxPieces` | Optional: most pieces she is willing to take on this order. |
| `fixedCostInr` | Per-maker activation cost (e.g. collection trip). **Unsupported in M1** — min-cost flow does not model activation decisions; any value > 0 makes pricing unresolved. |

**Collective**: `finishingPerDay[t]`; `lagDays` (a piece made on day `t` can be finished from
day `t + lagDays`); `packDays`; `transitDays`; per-piece finishing, packaging, collection
and disclosed collective charge; per-order international shipping; PayPal fee estimate;
INR/USD rate assumption.

**Reservations**: plans already accepted (and reserved) for other orders consume maker
capacity and finishing capacity on specific days; they are subtracted before planning.

**Order of operations.** Production day `t` ≥ `materialsReadyDay`; finishing day ≥ `t + lagDays`;
all finishing on or before `lastFinishDay = deliveryDay − transitDays − packDays − 1`.

**Costs are linear per unit** (maker ask, finishing, packaging, collection, charge) plus one
fixed per-order shipping cost. Per-maker fixed costs are not modelled (see above).

## 2. Result types

| Result | Required justification (checked by `check.ts`) |
|---|---|
| `feasible` | A plan satisfying every constraint, plus a cost-optimality certificate (or an explicit "cheapest not certified" flag). |
| `infeasible_capacity` | A **capacity cut** whose bound, recomputed from raw facts, is below the requested quantity. |
| `infeasible_budget` | A feasible plan whose cost is **certified minimal**, and whose minimum price exceeds the budget. |
| `unresolved` | Facts are missing, stale, inconsistent or unsupported. Lists exactly what is needed. A computation failure is also `unresolved`, never "impossible". |

A capacity "no" is only issued when **every** maker who could contribute has complete,
current facts and the deadline lies inside the planning horizon. With an incomplete maker,
a *feasible* plan that does not use her is still valid. It is labelled **cheapest not
certified**: the missing maker might allow a cheaper plan. The same restriction applies
when the deadline extends beyond known availability. A budget refusal requires a globally
certified minimum; if the known plan exceeds the budget but that minimum cannot be
certified, the answer is `unresolved`. The checker independently enforces these conditions.

Every primary plan is bound to the exact request's quantity, delivery day and budget.
Alternative plans are bound to an explicit transformed request (their own quantity/date,
with the original budget); their relationship to the original request is checked too.

### Alternatives (each a separate objective under the stated model)

- **Earliest delivery** for the full quantity — found by a monotone date search; proved by a plan on the
  found day and a cut for the day before. Monotone only while the recorded facts stay fixed.
  If nothing within the horizon works, the result says *"not within the next N days"*, not
  *"never"*.
- **Largest quantity** by the requested date — proved by a plan plus a cut with equal bound.
- **Lowest price** for the request — the certified minimum-cost plan priced with the fee formula.
- **Largest quantity within budget** by the requested date.

There is no single "smallest change"; these are distinct answers.

Each largest-within-budget answer includes `next`: a feasible plan and an optimality
certificate for **one more piece**, whose certified minimum price exceeds the budget.
This is required even when the affordable quantity is zero. Nonnegative costs make the
price monotone in quantity, so this boundary proves maximality. The offered positive
quantity also needs a feasible plan within budget. A largest-by-date claim needs a
feasible plan reaching its cut bound (zero is witnessed implicitly). An earliest-date
claim must carry a refusal for the preceding day; omitting it cannot certify "earliest".

## 3. Certificates

**Plan (yes).** Production entries `(maker, day, pieces)` and finishing entries `(day, pieces)`.
The checker re-derives capacities from raw facts and verifies: integrality; capability;
materials-ready day; per-day maker capacity after reservations; her commitments remain
satisfiable on what is left (earliest-deadline prefix condition, exact for unit pieces);
`maxPieces`; per-day finishing after reservations; for every day, cumulative finishing ≤
cumulative production lagged by `lagDays`; nothing finished after `lastFinishDay`; totals
equal the quantity; money recomputed. Expected pay is derived from production, not from
submitted payment lines. Each producing maker must have exactly one line; unknown,
non-producing, duplicate and missing payees are rejected. Every displayed cost component,
maker total, fee, overall total and lowest covering price is verified independently.

**Capacity cut (no).** A cut-off day `τ` and, per maker, either a day `u_m` or `"cap"`.
Bound, computed from raw facts:

```
B = Σ_{t=τ}^{lastFinish} finishing'[t]
  + Σ_m  ( "cap":  maxPieces_m
           u_m:    Σ_{t<u_m} cap'_m[t]  +  Σ_{u_m ≤ t, ready_m ≤ t ≤ τ−lag−1} cap'_m[t]  −  Σ_{k: due_k < u_m} pieces_k )
```

Every `(τ, u)` is the value of an s–t cut in the time-expanded network (minus the
commitments, which must all be served), hence an upper bound on the quantity the collective
can deliver. In words: *"before day τ, makers can have at most X pieces ready for finishing;
from day τ on, finishing can handle at most Y; X + Y < requested."* The solver finds the
minimising `(τ, u)` by enumeration and asserts it equals the maximum flow it computed.

**Cheapest (optimality).** Makers sorted by ask; for each price level `L`, the set `P_L` of
makers asking ≤ `L`. Any feasible plan has `y(P_L) ≤ min(Q, B_L)` where `B_L` is a cut bound
over `P_L` alone. If the offered plan has `x(P_L)` equal to that bound at every level, no
feasible plan is cheaper (summation by parts). The checker recomputes each `B_L`.

The flow solver uses integer paise for edge costs (asks support two decimal places),
avoiding floating-point costs on residual cycles. The checker derives maker counts from
production and checks the certificate's declared bounds against the raw facts.

## 4. Who sees what

| View | Contents |
|---|---|
| **Internal** (coordinator, authorised) | All facts with provenance, the full plan, all certificates, check results. |
| **Buyer / MCP agent** | Quantity, specification, dates, total price, and an aggregate explanation (e.g. "finishing can handle at most 42 before dispatch"). No maker's ask, floor, availability or commitments. |
| **Maker** | Her pieces, days, pay, conditions, and which shared dates her part depends on. |

A redacted buyer explanation is **not** a publicly checkable proof: checking optimality
requires the private costs. Full verification is internal in this version.

## 5. Money

```
makers      = Σ ask_m × pieces_m          (each ask ≥ her floor)
total cost  = makers + (finishing + packaging + collection + charge) × Q + shipping
price (USD) = least P with round(((P − fee(P)) / 100) × inrPerUsd) ≥ total cost,
              fee(P) = round(P × feePercent / 100) + feeFixed            — estimates
```

Amounts owed to makers, payments reported with a reference, and payments verified are
three different states and are never merged.

## 6. Runtime domain and limits

TypeScript types are not validation. The solver validates raw inputs before allocating a
network. The checker has a separate runtime validator and rejects malformed facts,
plans and certificates before arithmetic or array indexing; it does not import the
solver's schema. A well-formed `unresolved` answer can explain invalid inputs without
claiming feasibility or impossibility.

M1 supports:

- 1–366 horizon days, up to 50 uniquely identified makers; requested quantities 1–1,000,000.
- Integer daily capacities 0–10,000; nonnegative integer material-ready, delivery and
  commitment dates up to day 3,650. Lag, packing, transit and stale-age durations are
  integers 0–366. Dates outside known capacity cannot support a refusal.
- Nonnegative INR costs, asks and floors up to ₹1,000,000 per input, with at most two
  decimal places; maker limits 0–1,000,000 pieces. Existing promises contain positive
  integer quantities, up to 1,000 entries per maker.
- Fee estimates 0–20%, fixed fees 0–1,000,000 USD cents, and exchange rates ₹0.01–₹10,000
  per USD. Budget and output cent amounts are nonnegative safe integers. Pricing uses a
  bounded binary search; an unrepresentable price becomes `unresolved`.
- Up to 1,000 uniquely identified reservations and 20,000 total reservation entries.
  Entries have positive integer quantities, refer to known makers, and lie inside the
  horizon. Reservations never create capacity through negative subtraction.
- A valid UTC start date and valid ISO provenance timestamps at or before the planning
  time. Invalid/non-finite numbers, sparse arrays, fractional days, duplicate IDs and
  unsupported model versions are rejected. Certificate days and maker sets must also
  lie in the represented domain.

These bounds keep input sizes and arithmetic finite. They are implementation limits,
not evidence that inputs match the workshop or that a payment has settled.

## 7. Single-maker adapter (`src/lib/custom/capacity-proof.ts`)

A maker working alone is a collective of one. Her weekly pace becomes whole-piece days
(cumulative capacity through day `t` is `floor((t+1) × rate / 7)`); work already booked is
one undated promise, due first-in-first-out; she finishes her own pieces (no shared stage,
`lagDays = 0`, unlimited finishing); transit is her courier days.

The adapter answers **capacity questions only**: the earliest ready and delivery dates for
the full quantity, and the most pieces deliverable by the buyer's date, with the reason in
her terms ("at your pace you can make X by D, and Y are already promised"). Every answer
must pass `checkEvaluation` before it is shown; otherwise the seller sees the previous
formulas' numbers, without the "independently checked" wording. Prices stay with the
earnings calculator (`economics.ts`), which models her own costs.

The maximum is exact even when the requested quantity fits: the adapter probes beyond
the horizon's total production capacity (up to M1's request limit), then checks the
refusal's cut **and** its feasible maximum-quantity witness. A successful probe at the
request limit is only a lower bound, so it cannot be advertised as a checked maximum.
Date-only MCP queries perform this check too.

MCP exposes `earliestChecked` for the returned ready/delivery dates and `maximumChecked`
for `maxPiecesDeliveredBy`. The overall `capacityChecked` is true only when **every
requested result** is checked. An earliest date may be unavailable while a deadline's
maximum is checked, or the reverse; formula fallbacks never inherit another field's
verification status. With neither a quantity nor a deadline, no capacity answer is
certified and the overall flag is false.

Deadlines must be real, complete `YYYY-MM-DD` calendar dates. The adapter, capability
service and MCP input schema reject rollovers such as November 31 and February 29 in
a non-leap year. Past deadlines and deadlines extending beyond known production days
have no checked maximum in this adapter; existing formula estimates remain available
with `maximumChecked: false`. Invalid dates are rejected, rather than normalised or
silently discarded.

Stated assumptions: materials are in hand today (single-maker rules have no materials
date), and her saved rules are current (she edits them herself), so no staleness applies.
Beyond the one-year horizon the planner says "not within the horizon"; it never invents a
date. On every in-horizon case tested, its dates and quantities equal the previous
formulas, after fixing a floating-point rounding in the completion date (29 pieces at
7 a week took 30 days instead of 29).

## 8. Extension M1-Q1: one unknown materials date (`src/lib/planner/question.ts`)

M1 deliberately refuses to say "no" while a contributing maker's facts are incomplete
(§2): an unknown materials date makes the answer *unresolved*. M1-Q1 is a documented
extension, not a change to M1. The M1 answer stays *unresolved*; M1-Q1 adds a checked
statement about which dates would decide it. Results computed under M1 keep their M1
label; M1-Q1 results are reported separately.

**Scope.** It applies only when all of these hold. Otherwise Haat keeps the honest list of
unresolved facts. Several unknowns can interact, and no claim is made about them.
- The M1 answer is *unresolved*.
- Exactly one capable maker, *m*, has `materialsReadyDay = null`.
- Every other capable maker's facts are complete, current and consistent.
- Her own other facts are complete once the date is filled in.
- The last finishing day is inside the horizon.

**Hypothetical facts.** `withReadyDay(facts, m, r)` (in `model.ts`, shared by solver and
checker so both reason about identical facts) sets her date to day `r` with provenance
`system`, `by: "hypothetical — not a fact"`. Hypothetical values exist only inside the
calculation. They are never stored, and they never replace a maker-confirmed fact.

**Monotonicity.** Raising `r` removes production arcs (days `t < r`) and adds none. The
set of feasible plans therefore shrinks, so the maximum quantity cannot rise and the
certified minimum price cannot fall. "Feasible within the budget" holds for an interval
`r ∈ [0, r*]`, possibly empty. The solver finds `r*` by binary search over `[0, H]`;
`r = H` means she contributes nothing within the horizon.

**Answers.**
- **Threshold.** If her materials are ready by day `r*`, there is a plan: the plan at
  `r*` is checked with `checkPlan` and is within the budget. From day `r* + 1` the order
  fails, with the matching refusal at `r* + 1`. That refusal is either a capacity cut
  (`checkRefusal`) or a certified minimum price above the budget (`checkPlan` +
  `checkOptimality`).
- **No even if ready on day 0.** The matching refusal is checked at `r = 0`. By
  monotonicity it holds for every date.
- **Not applicable.** Any other case, including when the order works without her (then
  M1 itself answers).

**Checker.** `checkQuestion` (in `check.ts`, with the checker's own capacity code)
re-derives the scope from the raw facts and verifies both endpoints. Monotonicity is a
property of the model, argued above and tested over sampled dates
(`tests/collective-direction.test.ts`); the checker does not re-prove it for every date.

**Who sees it.** Only the coordinator sees it, with the question to send her ("if your
materials arrive by D, the order can go ahead"). The buyer is told the collective is
confirming availability.
