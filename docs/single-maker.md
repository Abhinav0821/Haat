# The single-maker shop (also built on Haat)

Before the collective work, Haat was a voice-first back office for one maker. It is still
in the app and still tested, but it is not the main story: see [direction.md](direction.md).
This page keeps its full description.

## Shop with an AI agent (MCP)

Haat exposes a remote MCP server at `/api/mcp` (Streamable HTTP). Add it as a custom connector in Claude or ChatGPT, e.g. `https://<your-host>/api/mcp`.

| Tool | What it does |
|---|---|
| `search_products` | Search the makers' live products by keyword / max price |
| `get_product` | Details, plus the maker's own words (original language + English) |
| `create_checkout` | Creates a PayPal order **at the shop's price** and returns a PayPal link the **human must approve**; the agent can never pay |
| `get_order_status` | CREATED → APPROVED → COMPLETED |
| `message_maker` / `get_messages` | Ask the maker; she reads it in her language and replies by voice, translated back |
| `get_maker_capabilities` | Capacity for made-to-order work: earliest ready date for N pieces, most pieces deliverable by a date (from her stated capacity and work already booked) |
| `request_custom_order` / `get_custom_request` | Send a custom request in plain language; read her checked options and the agreement status. The human approves terms and pays on the returned link |

Seller-written text is returned under `sellerProvided` and labelled as data, so a crafted product description can't instruct the buyer's agent.

## Scam Shield

Every buyer message is translated into the maker's language and checked for the scams that target new cross-border sellers: fake "I already paid" claims (verified against **PayPal's own order status**), ship-to-another-address requests (which void Seller Protection), off-PayPal payment, overpayment refunds, pressure tactics and attempts to instruct the AI. Warnings come from fixed Hindi/English templates and are read aloud first; buyers never see the verdict.

## Maker economics & stock

The maker states her costs, minimum and capacity **by voice** (“materials ₹350, packing ₹50, shipping costs me ₹1,200, charge the buyer $15, I need at least ₹1,500 per piece, four a week”). Gemini only extracts the numbers; Haat reads them back from a fixed template and nothing applies until she approves. One deterministic calculation is then used everywhere:

```
buyer pays            = goods + shipping CHARGED
left for her work (₹) = (buyer pays − est. PayPal fee) × est. ₹/$ − shipping COST − materials − packaging − other
```

Fee and exchange rate are labelled estimates (the actual fee is recorded from PayPal at capture). “Loss” is only said when the result is negative; otherwise “below your minimum”. Missing costs produce a question, not a number. She hears the result before publishing, and can correct a listing by voice (“दाम 1800 कर दो”, “यह सूती है”).

**One-of-a-kind stock:** each order reserves the piece under a row lock; every capture path (browser, agent return URL, webhook) re-checks the reservation, re-holding an expired one only if the piece is still free and otherwise refusing to capture (the buyer is never charged). Captures are counted once, including duplicate and recovered webhooks. Covered by concurrency tests (2 buyers / 1 piece, 10 agents / 3 pieces).

## Custom orders, on her terms

A buyer (or their AI agent) describes what they want — “12 red cotton scarves by December 10, around $300”. The maker hears a Hindi summary plus facts computed from **her** rules (“with work already booked, at most 7 can arrive by then; 12 pieces need at least $22.80 each”) and answers by voice: “seven by the 29th at $35 each, or all twelve by the 8th”.

- Gemini only turns speech/text into fields. **Code** checks every option against her minimum earnings, weekly capacity and work already booked (her stated backlog + approved and paid agreements). An option that breaks her rules is marked with the reason and **cannot be sent**.
- Buyers see price, ready-by date and a separately labelled delivery estimate — never her costs or earnings. A counter-offer is answered instantly from her rules; a lowball one is refused with alternatives that still meet her minimum (“10 pieces fit your budget”).
- The chosen option becomes an **immutable agreement**: terms hashed (SHA-256 of canonical JSON). Each approval records the hash it approved. Any change creates a new version, supersedes the old one and voids its approvals.
- **Whoever approves last**, the moment terms become fully approved her capacity and earnings are re-checked **atomically** (a shop-level lock), using the payment the terms actually contain — so two buyers can't both book the same week, and a quote made under old shipping rules can't slip through. If they no longer fit, her approval is cleared and she sends revised terms.
- PayPal checkout (Orders v2) is created only for the **current version approved by both**, for exactly its total. Before PayPal captures, that exact version is locked as **paying**: no revision, decline or re-approval until the outcome is known. Every state change takes the same locks in the same order (request, then agreement), so revision, decline and capture serialise instead of interleaving. Outcomes are decided from PayPal's **capture record** (a pending capture is not paid) and recorded by one idempotent finalisation step shared by the capture call, webhooks and reconciliation, which decides status under the order row lock (concurrent pending/completed notifications can’t move an order backwards); a webhook without a capture record asks PayPal for its own record and otherwise stays unprocessed for redelivery — order status, capture id and time, fees, buyer and shipping details, stock, agreement. The capture always stays with the version it charged. Approval holds her capacity for 48 h; a lapsed hold releases it.
- The terms carry **every clause in both languages** — the buyer's requirements ("exactly 2 metres"), her conditions ("dry clean only"), handmade variation and refunds — and both readings are generated from the same hashed terms.

- **Before paying**, buyer (or agent) and maker can talk on the request page — translated both ways and checked by Scam Shield, like every message. Messages never change terms; a change becomes a new version.
- **After paying**, the order shows as *being made*, not *ready to ship*. She taps as pieces are finished; finished pieces free up her booked capacity, the buyer sees progress, and only when every piece is done does the order move to *ready to ship* → spoken tracking → PayPal.
- **Invoices she dictates** to buyers outside Haat (Ask Haat) are checked against the same rules; a price below her minimum needs an explicit “create anyway”, enforced on the server.

Covered by `tests/custom-quote.test.ts`, `tests/custom-agreement.test.mts` and `tests/custom-integrity.test.mts` (revision during capture, revision/decline paused mid-transaction while a capture starts, reconciliation restoring the full order record, pending captures, approval order vs capacity, simultaneous final approvals, agreed-vs-current shipping, webhook capture retry, stale-payment reconciliation, concurrent stock counting — the last forced on real PostgreSQL), (supersede during checkout, hash mismatch, expiry, booked capacity, production progress, invoice override, no earnings leak). Verified live in the sandbox: request → spoken Hindi answer → agreement → PayPal payment → progress → PayPal tracking.

## Maker Evidence

A record of what was checked — not a guarantee. Each check reports its own result and scope: a photo of the piece beside a one-time handwritten code (passed / failed / uncertain), a Channel3 visual retail search (no match / possible match / not run), and a photo comparison with other Haat listings (no similar photo / similar found). It is “complete” only when all three ran and passed. **It shows the maker had this piece recently and that its photos are original; it does not prove who made it or how.** Records are Ed25519-signed (`/api/passport/{productId}`, key at `/api/passport/public-key`) — the signature proves the record is unchanged, not that its claims are true. MCP returns each check's stored result and the limitation (`withMakerEvidenceOnly` filter).

## पूछो हाट (Ask Haat)

A Hindi voice assistant for the seller. It answers from our records and PayPal's own data (Agent Toolkit `list_transactions`), and **drafts** actions — PayPal invoices (`create_invoice` → `send_invoice` → `generate_invoice_qr_code`, shareable on WhatsApp) and replies to buyers — that run only after the seller taps confirm. Each invoice is checked against her own costs and capacity first. It also answers about custom orders (new requests, agreements to approve, pieces still to make). It cannot move money; refunds stay behind the spoken code word.


## Scope notes for the single-maker shop

Being explicit about scope:

- **Finding buyers.** The storefront and MCP endpoint make her work available; they don't create demand. A real deployment needs a channel — an artisan collective, export partner or existing customers.
- **Export readiness.** PayPal India requires identity verification, PAN, bank details, purpose codes and (for goods) an IEC. Haat doesn't collect or automate these.
- **Shipping logistics.** No labels, customs forms or courier booking — only the shipping charge, her shipping cost, and tracking.
- **Dispute resolution.** Dispute events are recorded and surfaced; there is no full evidence-and-response workflow.
- **Automatic reconciliation for storefront orders.** Custom-order payments with an unknown outcome are reconciled automatically; for a storefront or agent order whose capture response was lost *and* whose webhooks were exhausted (PayPal retries for up to 3 days), recovery is manual: `npm run reconcile -- --stale`.
- **Notifications and buyer accounts.** Buyers see updates when they open their request or order page; Haat sends no email or SMS. The request link (an unguessable id) is the access control.
- **Multiple sellers.** The demo runs one maker; tables are keyed by store for later separation.
- **Languages.** Hindi is tested end to end; other Indian languages are supported by the model but not validated with users.

