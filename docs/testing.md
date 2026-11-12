# Testing Haat

Live demo: https://haat-teal.vercel.app

This is a PayPal **sandbox** demonstration. The makers and their facts are fictional.
The project owner played the roles in the recorded transactions. Maker payout records
use test references; no UPI or bank transfer is performed by Haat.

## 1. Try the buyer flow without setup

1. Open https://haat-teal.vercel.app/c/request.
2. Choose **Use an example**, or enter: “30 indigo block-printed cotton scarves,
   delivered in four weeks, total budget $300.”
3. Press **Read my request**. Review quantity, the resolved calendar date, total budget
   and requirements. Correct anything needed, then send the request.
4. Save the returned order link. It shows a checked first answer against the collective's
   current recorded facts. This is not yet an agreed plan or a payment request.

The dates and prices are calculated when you try it. Other demonstration orders may
already reserve capacity, so a smaller quantity or later date can be the correct answer.
If AI is temporarily unavailable, choose **Fill in the details myself**, retain the
request text, and enter a delivery date at least four weeks ahead. The same planner and
checker run after you confirm the fields.

## 2. Act as coordinator and makers

Use the coordinator PIN supplied in the submission's **private testing instructions**.
No Haat account is needed for the buyer or maker pages.

1. Sign in at https://haat-teal.vercel.app/seller/login and open
   https://haat-teal.vercel.app/seller/collective.
2. Open your request. The coordinator sees the checked answer, capacity and price
   alternatives, and the **Alone or together** comparison.
3. Under the makers, choose **New personal link** for each maker you will role-play.
   Save each link immediately: it is displayed once, and generating another invalidates
   the previous link. Keep these links private; possession permits actions as that maker.
4. Open each link in a separate tab. Choose Hindi or English. Review and confirm the
   fictional maker's facts if the coordinator sees estimates or stale confirmations.
   Do not invent a missing materials date: use one as an explicitly role-played fact.
5. Return to your request. If Hindi-reading makers are included and the request contains
   additional requirements, draft the Hindi reading, compare the back-translation,
   correct it if necessary, and choose **Save requirements**.
6. Choose **Send to makers** for the checked plan or an alternative you want to test.
7. On each participating maker's link, review her pieces, days and pay, then accept her
   part. She can also decline. Refresh the pages if the next state has not appeared yet.

Each maker sees only her part. The buyer sees aggregate terms, with no maker names,
individual pay or private costs. A personal link proves access to that link, not identity.

## 3. Pay in the sandbox

1. Return to your buyer link after every participating maker has accepted.
2. Review and approve the exact terms, then select **Pay with PayPal**.
3. Sign in with the **dedicated PayPal sandbox buyer** supplied privately. Do not use
   your real PayPal account or the sandbox business/merchant account.
4. Complete approval and return to Haat. The buyer page should show the paid state;
   the coordinator sees the capture and each maker's owed share.

Pay promptly after approving. Unpaid reservations expire after at most 48 hours and
before the first scheduled work day. If a hold expires, follow the page's request to
approve again or replan. If PayPal reports an uncertain outcome, let reconciliation
resolve it rather than creating repeated payment attempts.

The hosted merchant is a **US sandbox business account**. This does not demonstrate
onboarding or regulatory approval for a real Indian merchant.

## 4. Demonstrate maker-confirmed payout recording

On the coordinator page, record part of a maker's owed share using a clearly fictional
reference such as `DEMO-<your-order-id>-01`. This only records a report; it transfers no
money. Open that maker's link and confirm receipt as a role-play. The ledger then shows
her confirmation. The buyer page must continue to hide individual payout details.

## 5. Optional: use your own buyer agent

Follow https://haat-teal.vercel.app/agent to connect a compatible MCP client. This setup
is optional; the direct request flow above works without it.

Ask: “Use Haat to request 30 indigo scarves delivered in four weeks, total budget $300.
Show me exactly what you will send and wait for my OK.” The expected sequence is
`get_collective_info` → your confirmation → `request_collective_order` → an order link.
`get_collective_order` reads status. Continue with the coordinator, makers and human
payment steps above; the agent cannot approve or pay.

## Access and reproducibility

- Credentials belong only in the submission's private testing instructions, never in
  this repository, screenshots or the public video.
- The demo and its API access must remain available through December 15, 2026.
- Local setup is in [README.md](../README.md); the test suite runs with `npm test`.
- Evaluation evidence and its limits are in [docs/evaluation.md](evaluation.md).
- Refund allocation, replacement after a maker cannot finish, and collective shipment
  tracking are outside the demonstrated workflow.
