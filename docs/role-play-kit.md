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
  `collective` branch, with migrations up to `0019` applied.
- **Clear the previous session.** Remove collective orders from the last session
  (collective tables only). For a full demo reset, use `npm run demo:reset`; note that
  it also clears shop orders and custom requests.
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

## Design: the same task twice

Run each task once by the **manual method** and once **with Haat**. Alternate which
comes first between sessions, so learning doesn't favour one method.

**The manual method is the competent baseline.** The coordinator gets the facts sheet,
paper or a spreadsheet, and 15 minutes. She is asked for one of two answers:
- a split of pieces by maker and day, plus a price;
- a clear "no", with the most that could be done.

Afterwards, check her answer with the same independent checker the planner is held to.
Write her split as JSON (the format is at the top of `eval/check-split.ts`) and run
`npx tsx eval/check-split.ts split.json`. It reports whether the split is valid, what it
breaks, and the cheapest possible price. It uses the facts on the cards below with no
other orders holding capacity, so it fits task 1.

## Tasks

Delivery dates are given as "days from today", so the cards work on any session date.

1. **A big order (should fit).**
   - Lena asks for 60 indigo scarves, delivered in 24 days.
   - The coordinator records it (Hindi requirement: "नीला रंग") and sends a plan.
   - Each maker listens to her part (🔊) and accepts or declines.
   - Lena approves.
2. **A maker changes her price.**
   - After task 1's plan is sent, Rukhsana raises her asking price by ₹30 on her own page.
   - The coordinator sends a new plan.
   - *Check:* is only Rukhsana asked again? Do Meera and Sunita keep their answers?
3. **A competing order.**
   - With task 1 approved, a second buyer asks for 50 scarves by the same date.
   - *Check:* does the coordinator see "No", with the most that fits? Can she offer that
     smaller order, or the earliest date for all 50?
4. **A maker says no.**
   - In a fresh order, one maker declines her part, with a reason.
   - The coordinator chooses whether to leave her out and re-plan.
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

| Session | Task | Method (manual / Haat) | Order (1st / 2nd) | Minutes to a decision | Decision | Checker: valid? | If "no": kind right? | Maker answers right (of 4) | Felt able to say no (1–5) | Buyer understood (of 3) | Confusions / quotes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | | |

**Report:**
- **Per method:** decisions the checker accepted, unsafe promises, wrong kinds of "no",
  and the median minutes.
- **Per question:** how many people answered correctly.
- **Quotes:** verbatim, including critical ones.

With a handful of participants, present counts, not percentages, and make no claims of
statistical significance.

## After the session

- Clear the session's collective orders before the next one (see "Before the session").
- Keep the forms and the manual splits; check each split with `eval/check-split.ts`.
