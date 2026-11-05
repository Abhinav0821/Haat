# Haat pilot study — protocol

**Goal:** find out, honestly, whether a Hindi-speaking maker can run the core of a cross-border sale *by voice*, without English help — and where Haat fails. A small study with reported failures beats a large unsupported claim.

## Participants

- **3–5 people.** Record for each: target seller (sells handmade goods) **or** non-target tester (friend/family helping test usability). Report the two groups separately.
- Comfortable language, rough comfort with smartphones (none / some / regular), whether they currently sell online.
- Everything runs in the **PayPal sandbox** — no real money. Say so.

## Consent (read aloud)

> **हिंदी:** हम एक ऐप जाँच रहे हैं जो कारीगरों को बोलकर सामान बेचने में मदद करता है। इसमें असली पैसे नहीं लगते। हम आपका नाम नहीं लिखेंगे। आप कभी भी रुक सकते हैं। क्या हम आपके काम का समय और कहाँ दिक्कत हुई, यह लिख सकते हैं? आवाज़ रिकॉर्ड करें या नहीं — आपकी मर्ज़ी।
>
> **English:** We're testing an app that helps makers sell by speaking. No real money is involved. We won't record your name. You can stop at any time. May we note how long tasks take and where you got stuck? Recording your voice is optional.

## Setup

- Phone browser on the deployed app (or laptop on `localhost`), seller PIN entered by the facilitator.
- Start from a clean demo (`npm run demo:reset`). The reset archives the previous session's events to `.data/pilot-archive/`; summarise a session with `npm run pilot:report -- --from <file>`. Facilitator stays silent unless the participant is stuck for > 60 s; every intervention is recorded as **assistance**.

## Tasks

| # | Task (say it in Hindi) | Success = |
|---|---|---|
| T1 | “अपने खर्च और कम से कम कमाई बोलकर बताइए।” — set your costs and minimum by voice | Rules saved; read-back values match what they said |
| T2 | “एक सामान की फ़ोटो लेकर, बोलकर बेचने के लिए डालिए।” — list a piece by photo + voice | Published; price and material correct |
| T3 | “दाम बदलकर बोलिए।” — change something by voice before publishing | Correction applied and confirmed by read-back |
| T4 | Facilitator sends a fake “I already paid” screenshot. “यह संदेश सुनिए — क्या आप सामान भेजेंगी?” | Participant correctly says *don't ship* and why |
| T5 | Facilitator triggers a refund proposal. “इसे मंज़ूर कीजिए।” | Approved by saying the code word |

| T6 | Facilitator sends a custom request (“12 red scarves by Dec 10, budget $250”). “इसका जवाब बोलकर दीजिए।” | Answer heard correctly; any option that breaks her rules is shown as blocked and not sent; she sends a valid one and approves the terms |

## What to measure

| Measure | How |
|---|---|
| **Access** | Completed without English help? (yes / with assistance / no) — per task |
| **Accuracy** | Errors left after approval: wrong price, material, quantity, cost value |
| **Time** | Listing time is logged automatically (`npm run pilot:report`); also stopwatch per task |
| **Understanding** | T4: did they correctly decide *not* to ship? Ask them to explain in their words |
| **Corrections** | How often they used voice correction (logged automatically) |
| **Custom orders (T6)** | Time from request to answer, options blocked by her rules, counter-offers refused (logged automatically) |
| **Comparison** | Ask: “आज आप ऐसा कैसे करती हैं? कितना समय लगता है?” — their current process for the same task |

Three closing questions (1–5): *Easy to use? Would you trust it with real money? Would you use it?* — plus “सबसे मुश्किल क्या लगा?” (hardest part).

## Reporting (for README / Devpost)

- State **n**, how many were target sellers, and which tasks each completed.
- Report every failure and assistance, not only successes. Quote participants (with permission, no names).
- Keep **sandbox** results clearly separate from any real sales. Don't infer income gains from listing speed.

| Participant | Target? | T1 | T2 | T3 | T4 | T5 | T6 | Listing time | Errors after approval | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| P1 | | | | | | | | | | |
| P2 | | | | | | | | | | |
| P3 | | | | | | | | | | |
