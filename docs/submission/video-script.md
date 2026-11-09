# Demo video: script and shot list (target 2:45, hard limit 3:00)

**One idea, said three times:** an order too big for any one maker → the collective takes it
together → every promise checked, every maker agrees, the buyer pays with PayPal.

**Principles**
- Product on screen within 10 seconds.
- One person's problem, not statistics.
- Every claim shown working, never only said.
- The PayPal and AI moments are clearly labelled on screen.

**Setup before recording**
- Record **locally** after `npm run demo:reset`.
- The three makers confirm their facts on their own links. Set **Meera to English**; keep
  Sunita and Rukhsana in Hindi.
- Browser at 1467 px wide, zoom 110%. Hide bookmarks. Use a private window for each maker.
- Pick a request that **no maker can do alone** but the group can. 60 scarves by about 3
  weeks out works with the demo facts; check the "Alone or together" list says so before
  recording.
- The agent clip is the recorded Claude Desktop run on the live site (order `ed02f6a5…`), or
  a fresh screen recording of it.
- Use a calm voice, about 140 words a minute. The voice-over below is about 370 words.

| Time | On screen | Voice-over | Overlay text |
|---|---|---|---|
| 0:00–0:10 | Home page hero: "Bigger orders for small makers." Slow scroll to the four principles | "A boutique in Portland wants sixty hand block-printed scarves in three weeks. In Bagru, Rajasthan, no single block printer can make that many in time." | **Haat** · bulk orders for artisan collectives · PayPal + AI |
| 0:10–0:25 | Studio, "Alone or together": each maker's "at most N of 60" (the numbers on screen when recording) | "Each can make twenty or thirty. Usually the order goes to a factory, or someone promises dates nobody checked. Haat lets the collective take it together." | No maker alone. Together: yes. |
| 0:25–0:50 | `/c/request`: buyer types the request → **Read my request** → fields with "from your words" / "please check" badges → edits one → Confirm | "The buyer writes in plain words. AI reads them into quantity, date and budget, and code checks every value against the words. Anything not actually written is marked for the buyer to confirm. Nothing is planned until the buyer confirms." | **AI assists** · grounded in the buyer's words |
| 0:50–1:05 | Claude Desktop clip: agent restates the order, waits for OK, sends via Haat; returns the order link | "Or the buyer's own AI agent asks through Haat's MCP server. It confirms with the buyer first, and it can't approve or pay. The human does that." | **Agentic commerce** · MCP · the agent can't pay |
| 1:05–1:30 | Studio: "Today's facts, checked ✓ independently checked"; the plan table by day; cheapest certified | "Haat plans the work across each maker's recorded days, materials, other promises and price, plus the shared finishing table. A separate checker, sharing no code with the planner, verifies the plan before anyone sees it. If it can't be done, Haat says why, and what can." | **Code checks** · planner + independent checker |
| 1:30–1:55 | Draft Hindi with AI → back-translation box → Send to makers. Cut to Sunita's link (Hindi, 🔊 सुनें plays 2 s), then Meera's link in English → Accept | "Each maker gets only her own part, on her own link, in Hindi or English: her pieces, her days, her pay. AI drafts the Hindi requirements, and a separate translation back to English lets the coordinator check them. She says yes, or no." | **Makers decide** · her part, her language |
| 1:55–2:05 | A maker loses three days → "Keep 1 of 2 agreed parts … $1.43 more" → send | "If something changes, Haat keeps the parts that were already agreed, and shows what keeping them costs." | Changes keep agreed parts |
| 2:05–2:30 | Buyer page: total, "all makers confirmed" → I agree → Pay with PayPal → sandbox approve → ✓ Paid. Studio: capture ID, PayPal fee, webhooks received | "The buyer approves the exact terms and pays the collective once, with PayPal. Haat records PayPal's own capture, fee and net, and PayPal's webhook confirms it." | **Buyers pay with PayPal** · Orders v2 + webhooks |
| 2:30–2:42 | Studio: Record payment (UPI ref) → maker's link "Yes, received" → ✓ settled | "Each maker's share is owed from that payment. The coordinator pays her and records the reference, and only she can confirm it arrived." | Her share, confirmed by her |
| 2:42–2:55 | Closing card: three evaluation numbers and the repo/live URLs | "Tested on 46 cases with zero unsafe promises, and run end to end on the live site, including an order placed by an AI agent. Haat: bigger orders for small makers." | 46 test cases: 0 unsafe promises · 20 test requests: 0 wrong values shown as the buyer's words · haat-teal.vercel.app |

**Cut-down if over time:** shorten the replan beat (1:55–2:05) first, then the agent clip to
about 10 seconds. Never cut the PayPal payment or the checker beat.

**Don't say:**
- "only the maker can agree" (say "on her own link");
- "PayPal pays the makers";
- anything implying real makers used it (they were role-played).

The live site's PayPal is a US sandbox account; no need to mention it in the video, but don't
call it an Indian PayPal account.
