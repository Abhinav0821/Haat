# AI request intake — gemini-3.6-flash

20 of 20 hand-written buyer requests read (today = 2026-11-09). 60 field readings, each judged after code grounding (src/lib/collective/intake.ts).

| Outcome | Fields |
|---|---|
| Right, shown as from the buyer's words | 49 |
| Right or left empty, flagged for the buyer to check | 10 |
| Ambiguous phrase read plausibly but NOT flagged | 0 |
| Wrong, but flagged or left empty (caught before planning) | 1 |
| **Wrong and shown as from the buyer's words** | **0** |
| Stated in the words but not read | 0 |
| Off-product requests flagged | 1/1 |

Every reading is a proposal: the buyer confirms or edits each field before the order is planned.

| Case | Quantity | Date | Budget |
|---|---|---|---|
| i01 | right | right | right |
| i02 | right | right_flagged | right |
| i03 | right | right | right_flagged |
| i04 | right_flagged | right_flagged | right |
| i05 | right | right | right_flagged |
| i06 | right | wrong_caught | right |
| i07 | right | right | right |
| i08 | right | right | right |
| i09 | right | right | right |
| i10 | right | right | right |
| i11 | right | right | right |
| i12 | right | right_flagged | right |
| i13 | right | right | right |
| i14 | right | right_flagged | right |
| i15 | right | right | right |
| i16 | right | right | right |
| i17 | right | right_flagged | right_flagged |
| i18 | right | right_flagged | right |
| i19 | right | right | right |
| i20 | right | right | right |
