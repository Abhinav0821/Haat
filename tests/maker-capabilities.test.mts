import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";
process.env.PAYPAL_CLIENT_ID = "test";
process.env.PAYPAL_CLIENT_SECRET = "test";
process.env.GOOGLE_API_KEY = "test";
process.env.INR_PER_USD = "88";

const { db, schema, closeDb } = await import("@/db");
const { EconomicsSchema } = await import("@/lib/economics");
const { capacityProof } = await import("@/lib/custom/capacity-proof");
const { makerCapabilities } = await import("@/lib/custom/requests");
const { buildMcpServer } = await import("@/lib/mcp/server");
const rules = EconomicsSchema.parse({ materialsInr: 350, packagingInr: 50, shippingCostInr: 1200, minimumInr: 1500, piecesPerWeek: 1, backlogPieces: 0, shippingDays: 1 });
const now = new Date("2026-11-06T09:00:00Z");
const afterDays = (n: number) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n)).toISOString().slice(0, 10);
};
let storeId: string;
const server = buildMcpServer({ baseUrl: "http://localhost:3000", clientKey: "capability-test" });
const client = new Client({ name: "capability-test", version: "1" });
before(async () => {
  const d = await db();
  const [shop] = await d.insert(schema.stores).values({ slug: "capability-test", name: "Test", ownerName: "Maker", policy: { economics: rules } }).returning();
  storeId = shop.id;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
});
after(async () => { await client.close(); await server.close(); await closeDb(); });
async function capabilities(quantity?: number, deadline?: string) {
  const r = await makerCapabilities(storeId, quantity, deadline);
  assert.equal(r.acceptsCustomOrders, true);
  if (!r.acceptsCustomOrders) throw Error("fixture must accept custom orders");
  return r;
}

test("fallback dates outside the horizon are never labelled checked", async () => {
  const r = await capabilities(60);
  assert.ok(r.earliestReadyBy, "the existing formula remains available");
  assert.equal(r.earliestChecked, false);
  assert.equal(r.capacityChecked, false);
});

test("a known small order cannot certify a formula's two-year maximum", async () => {
  const r = await capabilities(1, afterDays(730));
  assert.equal(r.maxPiecesDeliveredBy?.pieces, 104);
  assert.equal(r.earliestChecked, true);
  assert.equal(r.maximumChecked, false);
  assert.equal(r.capacityChecked, false);
});

test("a fitting quantity still gets an exact independently checked maximum", () => {
  const p = capacityProof(rules, 1, "2026-12-26", now, 88); // 50 days; 49 working days
  assert.equal(p.verified, true);
  if (!p.verified) return;
  assert.equal(p.byDeadline?.fits, true);
  assert.equal(p.byDeadline?.max, 7, "a proof for one piece is not a proof that one is the maximum");
});

test("date-only MCP queries also verify their maximum", async () => {
  const r = await capabilities(undefined, afterDays(50));
  assert.equal(r.maxPiecesDeliveredBy?.pieces, 7);
  assert.equal(r.capacityChecked, true);
  assert.equal(r.earliestChecked, false);
  assert.equal(r.maximumChecked, true);
  assert.equal(r.earliestReadyBy, undefined);
});

test("the adapter rejects rollover dates and non-ISO date strings", () => {
  for (const date of ["2026-11-31", "2026-02-29", "2028-02-30", "2026-13-01", "2026-1-01", "2026-12-26T00:00:00Z", "2026-12-26garbage"]) {
    const p = capacityProof(rules, 1, date, now, 88);
    assert.equal(p.verified, false, date);
  }
});

test("the capability service rejects impossible calendar dates", async () => {
  for (const date of ["2026-11-31", "2026-02-29", "2100-02-29", "2026-12-26T00:00:00Z"]) {
    await assert.rejects(() => capabilities(1, date), /calendar date|YYYY-MM-DD/i);
  }
  await assert.doesNotReject(() => capabilities(1, "2028-02-29"));
});

test("the real MCP tool rejects rollover dates at its schema boundary", async () => {
  const bad = await client.callTool({ name: "get_maker_capabilities", arguments: { shop: "capability-test", quantity: 1, deliverBy: "2026-11-31" } });
  assert.equal(bad.isError, true);
  const good = await client.callTool({ name: "get_maker_capabilities", arguments: { shop: "capability-test", quantity: 1, deliverBy: afterDays(50) } });
  assert.notEqual(good.isError, true);
  const block = (good.content as { type: string; text?: string }[]).find((b) => b.type === "text");
  const data = JSON.parse(block!.text!);
  assert.equal(data.maxPiecesDeliveredBy.pieces, 7);
  assert.equal(data.capacityChecked, true);
  assert.equal(data.earliestChecked, true);
  assert.equal(data.maximumChecked, true);
  assert.equal("materialsInr" in data, false);
  assert.equal("minimumInr" in data, false);
});

test("a checked deadline maximum does not label an unavailable earliest date as checked", async () => {
  const r = await capabilities(60, afterDays(50));
  assert.equal(r.maxPiecesDeliveredBy?.pieces, 7);
  assert.equal(r.earliestChecked, false);
  assert.equal(r.maximumChecked, true);
  assert.equal(r.capacityChecked, false);
});

test("past deadlines use an unverified fallback; a zero maximum today still has a proof", async () => {
  const past = await capabilities(1, afterDays(-1));
  assert.equal(past.maxPiecesDeliveredBy?.pieces, 0);
  assert.equal(past.earliestChecked, true);
  assert.equal(past.maximumChecked, false);
  assert.equal(past.capacityChecked, false);
  const today = await capabilities(1, afterDays(0));
  assert.equal(today.maxPiecesDeliveredBy?.pieces, 0);
  assert.equal(today.maximumChecked, true);
  assert.equal(today.capacityChecked, true);
  const general = await capabilities();
  assert.equal(general.capacityChecked, false, "no dates or maximum were requested or proved");
});

test("valid leap days remain valid, while the unsupported maximum range stays unverified", () => {
  const leap = capacityProof(rules, 1, "2028-02-29", new Date("2028-02-01T09:00:00Z"), 88);
  assert.equal(leap.verified, true);
  if (leap.verified) assert.equal(leap.byDeadline?.date, "2028-02-29");
  // 3,660,000 pieces fit in this horizon, beyond M1's 1,000,000 request limit.
  // A successful probe at the limit is only a lower bound, never an exact max.
  const high = capacityProof({ ...rules, piecesPerWeek: 70_000 }, 1, "2027-11-08", now, 88);
  assert.equal(high.verified, true);
  if (high.verified) {
    assert.ok(high.earliest);
    assert.equal(high.byDeadline, null);
    assert.match(high.deadlineUnavailableReason!, /verification range/);
  }
});
