# Direction measures — seed 20261108

The same 46 synthetic cases as the M1 evaluation ([seed-20261108.md](seed-20261108.md)). Deterministic; no model calls. Reported separately: §C is extension M1-Q1, and §D's "most parts kept" comes from exhaustive search, not a certificate. Synthetic cases show what the method does on the model; they are not evidence about real collectives.

## B. Alone vs together

Of 18 checked "yes" cases:

| | Cases |
|---|---|
| No single maker could take it; the group could (both checked) | 3 |
| At least one maker could take it alone | 12 |
| A standalone answer was undecided (no claim made) | 3 |

## C. One unknown materials date (M1-Q1)

Of 7 "undecided" cases:

| | Cases |
|---|---|
| Threshold date found ("ready by D works; from D+1 it doesn't") | 3 |
| No even if her materials were ready on the first day | 2 |
| Out of scope (several unknowns, or other incomplete facts): the list of facts stays | 2 |
| Of the decided ones, passing the independent checker | 5/5 |

In these 5 cases M1 lists 5 open issue(s) — her date, sometimes with a minimum-price note — and stays undecided. M1-Q1 does not reduce how many facts are asked for; it adds which dates would work, or a checked "no" whatever her date.

## D. Keeping agreed parts after a change

Every checked "yes" case, with every maker having accepted her part, then one change. "Asked again" counts producing makers whose part is new or changed.

| Change | Cases | Re-plan possible | Agreed parts kept: fresh / keep-plan | Makers asked again: fresh / keep-plan | Cases with fewer asked | Premium when a keep-plan exists (median / max) |
|---|---|---|---|---|---|---|
| a producing maker drops out | 18 | 7 | 1 / 3 | 7 / 7 | 0 | $5.71 / $16.06 |
| a producing maker loses her first three working days in the plan | 18 | 17 | 7 / 10 | 23 / 21 | 2 | $0.00 / $5.35 |

A keep-plan can keep more agreed parts without asking fewer makers (it may bring in another maker for the shortfall). The premium is against the cheapest fresh plan; it is the price of keeping those agreements.

Kept parts are verified identical by terms hash, and every keep-plan passes the independent checker. That no larger set of parts could be kept is established by exhaustive search (at most 8 accepted parts), not by a certificate.
