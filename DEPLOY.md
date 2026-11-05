# Deploying Haat (free): Vercel + Neon

Haat runs locally with an embedded database. For a public URL, use **Vercel Hobby** (app) and **Neon Free** (Postgres). Both are free and need no card. Everything stays in the **PayPal sandbox**.

What the code already handles:
- **Migrations** run once during the Vercel build (`vercel-build` → `scripts/migrate.ts`), not on every cold start.
- **Database pooling**: postgres-js uses `prepare: false`, so Neon's pooled connection works.
- **Rate limits** (login, checkout, messages, custom requests, MCP) live in the database and hold across serverless instances.
- **APP_URL** defaults to the Vercel production domain, which PayPal's return and cancel links use.

## 1. Neon: create the database (about 3 min)

1. Sign up at **neon.tech** (GitHub login works) → **Create project**. Pick a region near Vercel's default (**US East**).
2. Open **Connection details** and turn on **Pooled connection**. Copy the connection string. Its host contains `-pooler`, and it ends with `?sslmode=require`.

## 2. Vercel: import the repo (about 5 min)

1. Sign up at **vercel.com** with GitHub, then **Add New → Project → Import** `Abhinav0821/Haat`. Private repos work once you grant the Vercel GitHub app access.
2. Keep the detected framework, **Next.js**. Leave the build command alone: Vercel runs the `vercel-build` script automatically.
3. Under **Environment Variables**, add these. Copy the values from your `.env.local`, apart from the first two:

| Name | Value |
|---|---|
| `DATABASE_URL` | the Neon **pooled** string from step 1 |
| `DB_POOL_MAX` | `3` |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | same as local (sandbox) |
| `PAYPAL_ENV` | `sandbox` |
| `AI_PROVIDER` | `google` |
| `GOOGLE_API_KEY`, `GOOGLE_MODEL`, `GOOGLE_FALLBACK_MODELS` | same as local |
| `CHANNEL3_API_KEY` | same as local (optional) |
| `SELLER_PASSCODE` | a **new** 6-digit PIN for the public site |
| `SESSION_SECRET` | a long random string, e.g. from `openssl rand -hex 32` |
| `PAYPAL_WEBHOOK_ID` | leave empty for now (step 3) |

4. Click **Deploy**. When it finishes, open `https://<your-app>.vercel.app/api/health`. It should return `{"ok":true,"db":"ok"}`.

## 3. PayPal: point a webhook at the deployed app

1. Go to developer.paypal.com → **Apps & Credentials** (Sandbox) → your app → **Add webhook**.
2. Set the URL to `https://<your-app>.vercel.app/api/webhooks/paypal`.
3. Select these events:
   - `CHECKOUT.ORDER.APPROVED`
   - `CHECKOUT.ORDER.COMPLETED`
   - `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REVERSED`, `PAYMENT.CAPTURE.REFUNDED`
4. Copy the new **Webhook ID**. In Vercel, open **Settings → Environment Variables**, set `PAYPAL_WEBHOOK_ID`, then **Redeploy**.

Keep the old webhook for the local tunnel if you still use it. Each webhook has its own ID.

## 4. Set up the demo shop on the deployed site

The Neon database starts empty, and the shop is created on the first seller sign-in.
1. Go to `/seller/login` and enter the PIN.
2. **नियम (Rules):** speak or type your costs, minimum and capacity, then approve them.
3. **नया (Add):** list the pieces using real photos and your voice.
4. Optional: open a piece's Maker Evidence and take the proof photo on a phone.

## 5. Check before sharing

- [ ] `/api/health` returns ok
- [ ] Storefront purchase with the **US** sandbox buyer. The order page shows "payment received", and the Vercel logs show `[webhook] PAYMENT.CAPTURE.COMPLETED`
- [ ] Custom request: send it, answer by voice, both approve, pay, mark pieces finished, add tracking
- [ ] Ask Haat answers "आज कितना कमाया?"
- [ ] Connect `https://<your-app>.vercel.app/api/mcp` as a custom connector in Claude or ChatGPT, then search and request a custom order

## Notes

- **Test buyers:** use the **US** sandbox personal account. An India-registered buyer paying the India-registered seller is declined by PayPal ("international regulations").
- **Free-tier limits:** Gemini's free tier allows about 5 requests per minute per model. Haat falls back across models, but space out pilot sessions.
- **Run migrations by hand** (e.g. against Neon from your laptop): `DATABASE_URL=... npm run db:migrate`.
- **Alternative host:** `render.yaml` describes the same app on Render. That needs a paid plan for Postgres.
