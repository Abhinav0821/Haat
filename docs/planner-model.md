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
a *feasible* plan that does not use her is still valid; a refusal is not.

### Alternatives (each a separate objective under the stated model)

- **Earliest delivery** for the full quantity — searched day by day; proved by a plan on the
  found day and a cut for the day before. Monotone only while the recorded facts stay fixed.
  If nothing within the horizon works, the result says *"not within the next N days"*, not
  *"never"*.
- **Largest quantity** by the requested date — proved by a plan plus a cut with equal bound.
- **Lowest price** for the request — the certified minimum-cost plan priced with the fee formula.
- **Largest quantity within budget** by the requested date.

There is no single "smallest change"; these are distinct answers.

## 3. Certificates

**Plan (yes).** Production entries `(maker, day, pieces)` and finishing entries `(day, pieces)`.
The checker re-derives capacities from raw facts and verifies: integrality; capability;
materials-ready day; per-day maker capacity after reservations; her commitments remain
satisfiable on what is left (earliest-deadline prefix condition, exact for unit pieces);
`maxPieces`; per-day finishing after reservations; for every day, cumulative finishing ≤
cumulative production lagged by `lagDays`; nothing finished after `lastFinishDay`; totals
equal the quantity; money recomputed.

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
