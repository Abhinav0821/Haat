import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = process.env.COLLECTIVE_TEST_DATABASE_URL ?? "";
process.env.PAYPAL_CLIENT_ID = "test";
process.env.PAYPAL_CLIENT_SECRET = "test";
process.env.GOOGLE_API_KEY = "test";
process.env.INR_PER_USD = "88";

const { db, schema, closeDb } = await import("@/db");
const { eq } = await import("drizzle-orm");
const svc = await import("@/lib/collective/service");
const { seedCollective, DEMO_MEMBERS } = await import("@/lib/collective/seed");
const { buyerView, internalView } = await import("@/lib/collective/views");
const { interpret } = await import("@/lib/collective/intake");
const { CollectiveError, offerPlan, respondToPart, createBuyerRequest, updateMemberFacts, currentPlan, earliestDelivery, settingsOf } = svc;

/** docs/direction.md §A, §B, §D through the service and views (database). */

const NOW = new Date("2026-11-07T09:00:00Z");
const later = (h: number) => new Date(NOW.getTime() + h * 3600_000);
type Seeded = Awaited<ReturnType<typeof seedCollective>>;
let n = 0;
let s: Seeded;
const tokenOf = (name: string) => s.members.find((m) => m.name === name)!.token;
const idOf = (name: string) => s.members.find((m) => m.name === name)!.id;
const rejects = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: unknown) => e instanceof CollectiveError && re.test(e.message));

before(async () => {
  await db();
});
after(async () => closeDb());

beforeEach(async () => {
  const d = await db();
  s = await seedCollective(d, { slug: `intake-${process.pid}-${++n}`, at: later(-24) });
  for (const m of DEMO_MEMBERS) await updateMemberFacts(idOf(m.name), m.facts, { source: "maker_confirmed", name: m.name }, later(-1));
});

const request = (spec: { quantity: number; deadline: string; budgetUsdCents?: number | null; details?: string | null }, extra: Record<string, unknown> = {}) =>
  createBuyerRequest(s.collective, { text: `${spec.quantity} scarves by ${spec.deadline}`, channel: "web", via: "form", spec: { budgetUsdCents: null, details: null, ...spec }, ...extra }, NOW);

test("buyer requests: confirmed requirements only, the earliest possible date enforced, the AI proposal kept beside them", async () => {
  const earliest = earliestDelivery(settingsOf(s.collective), NOW);
  assert.equal(earliest, "2026-11-18", "plan starts tomorrow + rest day + packing + transit");
  await rejects(request({ quantity: 30, deadline: "2026-11-17" }), /earliest delivery date/);
  await rejects(request({ quantity: 30, deadline: "2026-12-10" }, { buyerEmail: "not-an-email" }), /email/);
  await rejects(request({ quantity: 30, deadline: "2026-12-10", details: "नीला" }), /English/);

  const text = "30 indigo scarves by Dec 10, budget $250";
  const proposed = interpret(text, { quantity: 30, quantityWords: "30", deliverBy: "2026-12-10", deliverByWords: "by Dec 10", budget: { amount: 250, currency: "USD", basis: "total" }, budgetWords: "$250", item: "scarves", matchesProduct: "yes", details: "Indigo.", unclear: [] }, { today: "2026-11-07", earliest, inrPerUsd: 88, product: "scarf" });
  const o = await createBuyerRequest(s.collective, { text, channel: "web", via: "ai", model: "test-model", proposed, spec: { quantity: 32, deadline: "2026-12-10", budgetUsdCents: 25_000, details: "Indigo." } }, NOW);
  assert.equal((o.spec as { quantity: number }).quantity, 32, "the buyer's confirmed value is the order");
  assert.equal((o.spec as { detailsHi: string | null }).detailsHi, null, "the coordinator adds and reviews the Hindi");
  const intake = o.intake as { via: string; model: string; edited: string[]; proposed: { quantity: { value: number } } };
  assert.equal(intake.via, "ai");
  assert.deepEqual(intake.edited, ["quantity"]);
  assert.equal(intake.proposed.quantity.value, 30);
  await rejects(offerPlan(o.id, "primary", NOW), /Hindi/);
});

test("buyer view: a checked first answer and the aggregate sentence, with no maker's name, capacity or price", async () => {
  const o = await request({ quantity: 60, deadline: "2026-11-30" });
  const v = await buyerView(o.id, NOW);
  assert.equal(v.firstCheck?.kind, "feasible");
  assert.match(v.firstCheck!.headline, /^Yes: 60 pieces/);
  assert.equal(v.together, "No individual maker can fulfil this request within its date and budget. The collective can.");
  const json = JSON.stringify(v);
  for (const m of DEMO_MEMBERS) assert.ok(!json.includes(m.name), `buyer view leaks ${m.name}`);
  assert.ok(!/₹|askInr|floor|piecesPerWeekday/.test(json));

  // The coordinator sees each maker's standalone answer.
  const iv = await internalView(o.id, NOW);
  assert.equal(iv.comparison.alone.length, 3);
  assert.ok(iv.comparison.alone.every((a) => a.kind === "infeasible_capacity" && a.checked));

  // A small order one maker can do alone carries no aggregate sentence.
  const small = await request({ quantity: 8, deadline: "2026-12-20" });
  assert.equal((await buyerView(small.id, NOW)).together, null);
});

test("coordinator view: one unknown materials date becomes one checked question, never a stored fact", async () => {
  const f = DEMO_MEMBERS.find((m) => m.name === "Rukhsana")!.facts;
  await updateMemberFacts(idOf("Rukhsana"), { ...f, materialsDays: null, materialsReadyDate: null }, { source: "maker_confirmed", name: "Rukhsana" }, later(-1));
  const o = await request({ quantity: 60, deadline: "2026-11-30" });
  const iv = await internalView(o.id, NOW);
  assert.equal(iv.evaluation.kind, "unresolved");
  assert.equal(iv.question?.kind, "threshold");
  assert.equal(iv.question?.checked, true);
  assert.match(iv.question!.ask.hi, /सामान/);
  const [m] = await (await db()).select().from(schema.members).where(eq(schema.members.id, idOf("Rukhsana")));
  assert.equal((m.facts as { materialsReadyDate: string | null }).materialsReadyDate, null);
  assert.equal((await buyerView(o.id, NOW)).firstCheck?.kind, "unresolved", "the buyer is told the collective is confirming");
});

test("replanning keeps agreed parts: the kept part keeps her acceptance; only changed parts are asked again", async () => {
  const o = await createBuyerRequest(s.collective, { text: "40 scarves", channel: "web", via: "form", spec: { quantity: 40, deadline: "2026-12-05", budgetUsdCents: null, details: null } }, NOW);
  const plan = await offerPlan(o.id, "primary", NOW);
  const d = await db();
  const parts = async (planId: string) => {
    const [p] = await d.select().from(schema.collectivePlans).where(eq(schema.collectivePlans.id, planId));
    const refs = (p.terms as { parts: { memberId: string; partId: string; termsHash: string }[] }).parts;
    const rows = await d.select().from(schema.memberParts);
    return refs.map((r) => ({ ...r, row: rows.find((x) => x.id === r.partId)!, name: s.members.find((m) => m.id === r.memberId)!.name }));
  };
  const first = await parts(plan.id);
  assert.deepEqual(first.map((p) => p.name).sort(), ["Meera", "Sunita"]);
  for (const p of first) await respondToPart(tokenOf(p.name), p.partId, p.termsHash, "accept", null, NOW);

  // Meera can no longer work three of her agreed days: the plan must change.
  const meera = DEMO_MEMBERS.find((m) => m.name === "Meera")!.facts;
  await updateMemberFacts(idOf("Meera"), { ...meera, offDates: ["2026-11-16", "2026-11-17", "2026-11-18"] }, { source: "maker_confirmed", name: "Meera" }, NOW);
  assert.equal((await currentPlan(d, o.id, NOW))!.status, "needs_replan");

  const iv = await internalView(o.id, NOW);
  assert.ok(iv.keep && !("none" in iv.keep && iv.keep.none));
  if (!iv.keep || ("none" in iv.keep && iv.keep.none)) return;
  assert.deepEqual(iv.keep.kept.map((k) => k.name), ["Sunita"]);
  assert.equal(iv.keep.search, "exhaustive");

  const next = await offerPlan(o.id, "keep_agreed", NOW);
  assert.equal(next.choice, "keep_agreed");
  const after = await parts(next.id);
  const sunita = after.find((p) => p.name === "Sunita")!;
  assert.equal(sunita.partId, first.find((p) => p.name === "Sunita")!.partId, "her part is the same row");
  assert.equal(sunita.row.status, "accepted", "her acceptance stands");
  assert.ok(after.filter((p) => p.name !== "Sunita").every((p) => p.row.status === "pending"), "changed parts are asked again");
});

test("MCP: a buyer's agent requests with confirmed fields and reads only aggregate status", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { buildMcpServer } = await import("@/lib/mcp/server");
  const server = buildMcpServer({ baseUrl: "https://haat.test", clientKey: `test-${process.pid}` });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-agent", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(tools.includes("request_collective_order") && tools.includes("get_collective_order"));

  const date = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
  const res = await client.callTool({ name: "request_collective_order", arguments: { request: "Thirty indigo scarves for our boutique", quantity: 30, deliverBy: date, budgetUsd: 400 } });
  const out = JSON.parse((res.content as { text: string }[])[0].text);
  assert.ok(out.orderId && out.buyerLink.endsWith(`/c/orders/${out.orderId}`));
  const status = await client.callTool({ name: "get_collective_order", arguments: { orderId: out.orderId } });
  const text = (status.content as { text: string }[])[0].text;
  for (const m of DEMO_MEMBERS) assert.ok(!text.includes(m.name), `agent output leaks ${m.name}`);
  const [row] = await (await db()).select().from(schema.collectiveOrders).where(eq(schema.collectiveOrders.id, out.orderId));
  assert.equal(row.channel, "mcp");
  assert.equal((row.intake as { via: string }).via, "agent");
  // An unconfirmed (missing) date is refused by the tool's schema, not guessed.
  const bad = await client.callTool({ name: "request_collective_order", arguments: { request: "some scarves", quantity: 30 } });
  assert.equal(bad.isError, true);
  await client.close();
});

test("payment record lists PayPal's webhook notifications for that payment only (order or capture id)", async () => {
  const { paymentOf } = await import("@/lib/collective/views");
  const d = await db();
  const pid = `PP-${process.pid}-${Date.now()}`;
  const [o] = await d.insert(schema.orders).values({ storeId: null, paypalOrderId: pid, paypalCaptureId: `CAP-${pid}`, status: "COMPLETED", amountCents: 1000, currency: "USD", items: [], channel: "web" }).returning();
  await d.insert(schema.webhookEvents).values([
    { id: `WH-1-${pid}`, type: "CHECKOUT.ORDER.APPROVED", payload: { resource: { id: pid } }, processedAt: new Date() },
    { id: `WH-2-${pid}`, type: "PAYMENT.CAPTURE.COMPLETED", payload: { resource: { id: `CAP-${pid}`, supplementary_data: { related_ids: { order_id: pid } } } } },
    { id: `WH-3-${pid}`, type: "PAYMENT.CAPTURE.COMPLETED", payload: { resource: { id: "someone-else" } } },
  ]);
  const p = await paymentOf(d, o.id);
  assert.deepEqual(p?.webhooks.map((w) => [w.type, w.processed]), [["CHECKOUT.ORDER.APPROVED", true], ["PAYMENT.CAPTURE.COMPLETED", false]]);
});
