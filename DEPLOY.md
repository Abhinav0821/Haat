# Deploying Haat: Vercel + Neon

Haat's submitted flow is the artisan collective: buyer request → checked plan → maker
consent → human PayPal payment → maker-confirmed payout record. The hosted demo uses
**PayPal sandbox**, with a US sandbox business account. No real money moves.

## Configure the deployment

1. Create a Neon Postgres database and copy its pooled connection URL.
2. Import `Abhinav0821/Haat` into Vercel with Next.js as the framework and `main` as the
   production branch. The `vercel-build` script applies migrations, then builds Next.js.
3. Configure these production environment variables using your own credentials:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon pooled connection URL with SSL |
| `DB_POOL_MAX` | `3`, to limit serverless database connections |
| `PAYPAL_ENV` | `sandbox` |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | The sandbox merchant application's credentials |
| `PAYPAL_WEBHOOK_ID` | The webhook belonging to that same application and this deployment |
| `AI_PROVIDER` | `google` for the recorded demonstration |
| `GOOGLE_API_KEY`, `GOOGLE_MODEL`, `GOOGLE_FALLBACK_MODELS` | A project/key and models with available quota |
| `SELLER_PASSCODE` | A dedicated studio PIN, supplied privately to judges |
| `SESSION_SECRET` | A long random session-signing secret |
| `APP_URL` | Optional on Vercel: defaults to `VERCEL_PROJECT_PRODUCTION_URL`; if supplied, use the public HTTPS origin, never localhost |

The remaining optional settings are documented in `.env.example`. Do not put API keys,
PINs, database URLs or personal maker links in Git or the public submission.

## Register PayPal webhooks

In the sandbox merchant application, register
`https://<your-domain>/api/webhooks/paypal` for:

- `CHECKOUT.ORDER.APPROVED`, `CHECKOUT.ORDER.COMPLETED`
- `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DENIED`
- `PAYMENT.CAPTURE.REVERSED`, `PAYMENT.CAPTURE.REFUNDED`

Set that endpoint's webhook ID in Vercel and redeploy. Local tunnels and production
endpoints have different webhook IDs. Use a sandbox personal **buyer** account to approve
payments, not the merchant account and not a real PayPal login.

## Check a release

1. `/api/health` must report `ok: true`, the expected commit, and equal applied/expected
   migration counts. It currently expects 22 migrations, through `0021_maker_language`.
2. Open `/c/request` and `/agent` while signed out. `/agent` must show the public HTTPS
   MCP URL and the no-setup request option.
3. The demo collective is created on first use. Sign in at `/seller/login`, open
   `/seller/collective`, and generate/save the makers' personal links privately.
4. Follow [the judge guide](docs/submission/judge-guide.md). Check the confirmed request,
   checked answer, maker consent, buyer approval, sandbox capture and maker shares.
5. Verify actual webhook delivery and processing in the PayPal application/Vercel logs.
   A successful browser return alone is not evidence of webhook delivery.
6. An external agent should list the three collective tools and return the same kind of
   first answer and buyer link. It must not approve or pay.

Preserve the existing paid sandbox evidence. Do not reset the hosted database to prepare
a video. Locally, use an isolated database as described in the video script.

## Keep the judging demo usable

- Keep the deployment, database and AI quota available through **December 15, 2026**.
- Confirm the fictional maker facts before recording. If existing settings still use
  30-day freshness, update them deliberately; deploying newer seed code does not change
  an existing collective. New demo collectives use 60 days.
- Judge requests use dates relative to the day of testing. Avoid fixed November/December
  delivery dates in example prompts.
- Capacity already reserved by earlier orders can legitimately change the next answer.
  Do not clear successful transactions to force a favourable answer.
- AI failures have a manual request-entry fallback. Keep quota available for the AI
  demonstration; provider limits are project-specific and can change.
- A missing payment outcome is reconciled from PayPal's record by the collective flow.
  Storefront recovery also has `npm run reconcile -- --stale`; it is outside the main demo.

For another host, `render.yaml` provides a starting point; configure a real Postgres
connection and the same public URL/webhook settings. Never use embedded PGlite for a
serverless production deployment.
