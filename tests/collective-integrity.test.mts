import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PartTerms } from "@/lib/collective/terms";

// Use only an explicitly supplied disposable PostgreSQL database, otherwise memory.
process.env.DATABASE_URL = process.env.COLLECTIVE_TEST_DATABASE_URL ?? "";
process.env.PGLITE_DIR = "memory://";
process.env.PAYPAL_CLIENT_ID = "test";
process.env.PAYPAL_CLIENT_SECRET = "test";
process.env.GOOGLE_API_KEY = "test";
process.env.INR_PER_USD = "88";
const { db, schema, closeDb } = await import("@/db");
const { eq, sql } = await import("drizzle-orm");
const svc = await import("@/lib/collective/service");
const { seedCollective, DEMO_MEMBERS, demoSettings } = await import("@/lib/collective/seed");
const { MemberFactsSchema, SettingsSchema, buildFacts } = await import("@/lib/collective/facts");
const { makerView } = await import("@/lib/collective/views");

const NOW = new Date("2026-11-07T09:00:00Z");
const at = (hours: number) => new Date(NOW.getTime() + hours * 3600_000);
const details = "Exactly 2 metres long. Dry clean only.";
const detailsHi = "ठीक 2 मीटर लंबा। सिर्फ़ ड्राई क्लीन।";
before(async () => { await db(); });
after(closeDb);
async function setup(quantity = 25, readyDate?: string) {
  const s = await seedCollective(await db(), { slug: `integrity-${randomUUID()}`, at: at(-24) });
  for (const m of DEMO_MEMBERS) await svc.updateMemberFacts(s.members.find((x) => x.name === m.name)!.id, { ...m.facts, ...(readyDate ? { materialsReadyDate: readyDate } : {}) }, { source: "maker_confirmed", name: m.name }, NOW);
  const spec = { quantity, deadline: "2026-11-30", budgetUsdCents: null, details, detailsHi };
  const o = await svc.createOrder(s.collective.id, { buyerText: "Custom scarves", spec });
  const p = await svc.offerPlan(o.id, "primary", NOW);
  const refs = (p.terms as { parts: { memberId: string; partId: string; termsHash: string }[] }).parts;
  for (const r of refs) await svc.respondToPart(s.members.find((m) => m.id === r.memberId)!.token, r.partId, r.termsHash, "accept", null, NOW);
  const who = s.members.find((m) => m.id === refs[0].memberId)!;
  return { s, o, p, refs, who };
}
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}
const reserved = async (collectiveId: string, now = NOW) => (await svc.activeReservations(await db(), collectiveId, now)).length;
async function assertWaiting<T>(pending: Promise<T>) {
  if (process.env.COLLECTIVE_TEST_DATABASE_URL) {
    // Observe a real server lock wait, rather than assuming that a slow promise
    // means the second connection reached SELECT FOR UPDATE.
    for (let i = 0; i < 100; i++) {
      const rows = await (await db()).execute(sql`select pid from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like 'select id from collectives%for update' and cardinality(pg_blocking_pids(pid)) > 0`);
      if ((rows as unknown as unknown[]).length > 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail("The second connection never reached the collective row lock");
  }
  assert.equal(await Promise.race([pending.then(() => "finished", () => "rejected"), new Promise<string>((r) => setTimeout(() => r("waiting"), 100))]), "waiting");
}

test("a stale expiry reader cannot clear a freshly renewed buyer approval", async () => {
  const { s, o, p } = await setup(25, "2026-11-15");
  await svc.buyerApprove(p.id, p.termsHash, NOW);
  const entered = gate(), resume = gate(), later = at(49);
  const stale = svc.currentPlan(await db(), o.id, later, { afterRead: async () => { entered.open(); await resume.promise; } });
  await entered.promise;
  try { assert.equal((await svc.buyerApprove(p.id, p.termsHash, later)).status, "approved"); }
  finally { resume.open(); }
  await stale;
  const current = await svc.currentPlan(await db(), o.id, later);
  assert.equal(current?.status, "approved");
  assert.equal(current.holdUntil?.getTime(), later.getTime() + svc.HOLD_MS);
  assert.equal(await reserved(s.collective.id, later), 1);
});

test("a meaningful fact edit invalidates affected unpaid holds atomically", async () => {
  const { s, o, p, who } = await setup();
  await svc.buyerApprove(p.id, p.termsHash, NOW);
  const original = DEMO_MEMBERS.find((m) => m.name === who.name)!.facts;
  await svc.updateMemberFacts(who.id, { ...original, piecesPerWeekday: [0, 0, 0, 0, 0, 0, 0] }, { source: "maker_confirmed", name: who.name }, NOW);
  const current = await svc.currentPlan(await db(), o.id, NOW);
  assert.equal(current?.status, "needs_replan");
  assert.equal(current.buyerApprovedHash, null);
  assert.equal(await reserved(s.collective.id), 0);
  await assert.rejects(() => svc.buyerApprove(p.id, p.termsHash, NOW), /revised/);
});

test("confirming identical facts preserves an existing hold and material-ready date", async () => {
  const { s, o, p, who } = await setup();
  await svc.buyerApprove(p.id, p.termsHash, NOW);
  const [m] = await (await db()).select().from(schema.members).where(eq(schema.members.id, who.id));
  await svc.updateMemberFacts(who.id, m.facts, { source: "maker_confirmed", name: who.name }, at(1));
  assert.equal((await svc.currentPlan(await db(), o.id, at(1)))?.status, "approved");
  assert.equal(await reserved(s.collective.id, at(1)), 1);
});

test("material delays are anchored to their statement date, not the plan's start", () => {
  const f = MemberFactsSchema.parse({ ...DEMO_MEMBERS[1].facts, materialsDays: 5, prov: { source: "maker_confirmed", by: "Sunita", at: "2026-11-09T09:00:00Z" } });
  const settings = demoSettings("2026-11-06T09:00:00Z");
  const first = buildFacts(settings, [{ id: "s", name: "Sunita", facts: f }], [], "2026-11-08");
  const replanned = buildFacts(settings, [{ id: "s", name: "Sunita", facts: f }], [], "2026-11-10");
  assert.equal(first.makers[0].materialsReadyDay?.value, 6); // November 14
  assert.equal(replanned.makers[0].materialsReadyDay?.value, 4); // still November 14
});

test("English-only draft requirements cannot be offered for maker consent", async () => {
  const s = await seedCollective(await db(), { slug: `translation-${randomUUID()}`, at: at(-24) });
  const o = await svc.createOrder(s.collective.id, { buyerText: details, spec: { quantity: 10, deadline: "2026-11-30", budgetUsdCents: null, details } });
  await assert.rejects(() => svc.offerPlan(o.id, "primary", NOW), /Hindi|हिंदी/);
});

test("both readings are frozen in the maker's fingerprinted terms", async () => {
  const { p, who, refs } = await setup(10);
  const view = await makerView(who.token, NOW);
  assert.match(view.parts[0].readback, /ठीक 2 मीटर लंबा। सिर्फ़ ड्राई क्लीन।/);
  assert.ok(!view.parts[0].readback.includes(details));
  const [part] = await (await db()).select().from(schema.memberParts).where(eq(schema.memberParts.id, refs[0].partId));
  assert.equal(part.terms.details, details);
  assert.equal(part.terms.detailsHi, detailsHi);
  const { hashOf } = await import("@/lib/collective/terms");
  assert.equal(hashOf(part.terms), part.termsHash);
  assert.notEqual(hashOf({ ...part.terms, detailsHi: "सिर्फ़ हाथ से धोएँ।" }), part.termsHash);
  assert.ok((p.terms as { parts: { termsHash: string }[] }).parts.some((r) => r.termsHash === part.termsHash));
});

test("valid two-decimal rupee inputs are accepted; third decimals are rejected", () => {
  for (const amount of [1.10, 0.29, 9.95, 420.13]) {
    const settings = demoSettings(NOW.toISOString());
    settings.costs.collectionInrPerPiece = amount;
    assert.equal(SettingsSchema.safeParse(settings).success, true, String(amount));
    assert.equal(MemberFactsSchema.safeParse({ ...DEMO_MEMBERS[0].facts, askInr: amount, floorInr: amount, prov: settings.prov }).success, true);
  }
  assert.equal(MemberFactsSchema.safeParse({ ...DEMO_MEMBERS[0].facts, askInr: 420.131, prov: demoSettings(NOW.toISOString()).prov }).success, false);
});

test("fact edits wait for an approval's read/check/reserve transaction", async () => {
  const { s, o, p, who } = await setup();
  const read = gate(), resume = gate();
  const approving = svc.buyerApprove(p.id, p.termsHash, NOW, { afterFactsRead: async () => { read.open(); await resume.promise; } });
  await read.promise;
  const f = DEMO_MEMBERS.find((m) => m.name === who.name)!.facts;
  const edit = svc.updateMemberFacts(who.id, { ...f, piecesPerWeekday: [0, 0, 0, 0, 0, 0, 0] }, { source: "maker_confirmed", name: who.name }, NOW);
  try {
    await assertWaiting(edit);
  } finally { resume.open(); }
  await approving;
  await edit;
  assert.equal((await svc.currentPlan(await db(), o.id, NOW))?.status, "needs_replan");
  assert.equal(await reserved(s.collective.id), 0);
});

test("approval waits for a fact edit, then refuses the invalidated version", async () => {
  const { s, o, p, who } = await setup();
  const entered = gate(), resume = gate();
  const f = DEMO_MEMBERS.find((m) => m.name === who.name)!.facts;
  const edit = svc.updateMemberFacts(who.id, { ...f, piecesPerWeekday: [0, 0, 0, 0, 0, 0, 0] }, { source: "maker_confirmed", name: who.name }, NOW, { afterRead: async () => { entered.open(); await resume.promise; } });
  await entered.promise;
  const approving = svc.buyerApprove(p.id, p.termsHash, NOW);
  const refused = assert.rejects(approving, /revised/);
  try { await assertWaiting(approving); }
  finally { resume.open(); }
  await edit;
  await refused;
  assert.equal((await svc.currentPlan(await db(), o.id, NOW))?.status, "needs_replan");
  assert.equal(await reserved(s.collective.id), 0);
});

test("a new material delay is dated from the edit; unrelated edits preserve it", async () => {
  const { who } = await setup();
  const f = DEMO_MEMBERS.find((m) => m.name === who.name)!.facts;
  const changed = await svc.updateMemberFacts(who.id, { ...f, materialsDays: 7 }, { source: "maker_confirmed", name: who.name }, at(48));
  assert.equal(changed.facts.materialsReadyDate, "2026-11-16");
  const legacyInput = { ...changed.facts };
  delete legacyInput.materialsReadyDate;
  const confirmed = await svc.updateMemberFacts(who.id, { ...legacyInput, askInr: 900 }, { source: "maker_confirmed", name: who.name }, at(72));
  assert.equal(confirmed.facts.materialsReadyDate, "2026-11-16");
});

test("editing only the Hindi reading releases the hold and requires new maker consent", async () => {
  const { s, o, p, refs } = await setup();
  await svc.buyerApprove(p.id, p.termsHash, NOW);
  const revisedHi = "लंबाई ठीक 2 मीटर हो। केवल ड्राई क्लीन करें।";
  await svc.updateOrderRequirements(o.id, details, revisedHi, NOW);
  assert.equal(await reserved(s.collective.id), 0);
  await assert.rejects(() => svc.buyerApprove(p.id, p.termsHash, NOW), /revised/);
  const next = await svc.offerPlan(o.id, "primary", NOW);
  assert.notEqual(next.termsHash, p.termsHash);
  const nextRefs = (next.terms as { parts: typeof refs }).parts;
  for (const r of refs) {
    const [old] = await (await db()).select().from(schema.memberParts).where(eq(schema.memberParts.id, r.partId));
    assert.equal(old.terms.detailsHi, detailsHi); // old words remain frozen
    assert.equal(old.status, "superseded");
    assert.ok(!nextRefs.some((n) => n.partId === r.partId));
  }
  await assert.rejects(() => svc.buyerApprove(next.id, next.termsHash, NOW), /Not every maker/);
  for (const r of nextRefs) await svc.respondToPart(s.members.find((m) => m.id === r.memberId)!.token, r.partId, r.termsHash, "accept", null, NOW);
  assert.equal((await svc.buyerApprove(next.id, next.termsHash, NOW)).status, "approved");
});

test("an English-only legacy part cannot be accepted or used for buyer approval", async () => {
  const { p, refs, who } = await setup();
  const [part] = await (await db()).select().from(schema.memberParts).where(eq(schema.memberParts.id, refs[0].partId));
  const legacy = { ...part.terms };
  delete legacy.detailsHi;
  const { hashOf, partReadbackHi } = await import("@/lib/collective/terms");
  const legacyHash = hashOf(legacy);
  await (await db()).update(schema.memberParts).set({ terms: legacy, termsHash: legacyHash, respondedHash: legacyHash }).where(eq(schema.memberParts.id, part.id));
  const terms = p.terms as { parts: typeof refs };
  terms.parts[0].termsHash = legacyHash;
  const planHash = hashOf(terms);
  await (await db()).update(schema.collectivePlans).set({ terms, termsHash: planHash }).where(eq(schema.collectivePlans.id, p.id));
  await assert.rejects(() => svc.respondToPart(who.token, part.id, legacyHash, "accept", null, NOW), /Hindi/);
  await assert.rejects(() => svc.buyerApprove(p.id, planHash, NOW), /Not every maker/);
  assert.ok(!partReadbackHi(legacy as unknown as PartTerms).includes(details));
});

test("fact and requirement edits are refused while a payment is in progress", async () => {
  const { o, p, who } = await setup();
  await svc.buyerApprove(p.id, p.termsHash, NOW);
  await (await db()).update(schema.collectivePlans).set({ status: "paying" }).where(eq(schema.collectivePlans.id, p.id));
  const [before] = await (await db()).select().from(schema.members).where(eq(schema.members.id, who.id));
  await assert.rejects(() => svc.updateMemberFacts(who.id, { ...before.facts, askInr: 900 }, { source: "maker_confirmed", name: who.name }, NOW), /payment.*processed/i);
  await assert.rejects(() => svc.updateOrderRequirements(o.id, details, "बदली हुई शर्त।", NOW), /during or after payment/);
  const [after] = await (await db()).select().from(schema.members).where(eq(schema.members.id, who.id));
  assert.deepEqual(after.facts, before.facts);
});

test("evaluation exports freeze actual reservations and current prices under the planning locks", async () => {
  const { s, p, who } = await setup();
  await svc.buyerApprove(p.id, p.termsHash, NOW);
  const other = await svc.createOrder(s.collective.id, { buyerText: "50 scarves", spec: { quantity: 50, deadline: "2026-11-30", budgetUsdCents: null, details: null } });
  const snapshot = await svc.exportEvaluationSnapshot(other.id, NOW);
  assert.equal(snapshot.facts.reservations.length, 1);
  assert.equal(snapshot.facts.reservations[0].production.reduce((n, p) => n + p.pieces, 0), 25);
  const run = await svc.evaluateOrder(other.id, NOW);
  const { factsHash } = await import("@/lib/planner/model");
  assert.equal(snapshot.factsFingerprint, factsHash(run.facts, run.request));
  const f = DEMO_MEMBERS.find((m) => m.name === who.name)!.facts;
  await svc.updateMemberFacts(who.id, { ...f, askInr: f.askInr + 30 }, { source: "maker_confirmed", name: who.name }, NOW);
  const changed = await svc.exportEvaluationSnapshot(other.id, NOW);
  assert.equal(changed.facts.makers.find((m) => m.id === who.id)!.askInrPerPiece.value, f.askInr + 30);
  assert.equal(changed.facts.reservations.length, 0);
  assert.notEqual(changed.fingerprint, snapshot.fingerprint);
});

test("evaluation exports retain an explicitly excluded maker as incapable", async () => {
  const { o, refs, who } = await setup();
  await svc.respondToPart(who.token, refs[0].partId, refs[0].termsHash, "decline", null, NOW);
  await svc.excludeMember(o.id, who.id);
  const snapshot = await svc.exportEvaluationSnapshot(o.id, NOW);
  assert.equal(snapshot.facts.makers.find((m) => m.id === who.id)?.capable.value, false);
});

test("the evaluation download is private and requires the coordinator's own order", async () => {
  process.env.SELLER_PASSCODE = "offline-evaluation-test";
  process.env.SESSION_SECRET = "offline-evaluation-secret";
  const { GET } = await import("@/app/api/seller/collective/orders/[id]/route");
  const { createSessionToken } = await import("@/lib/auth/session");
  const { getDemoCollective } = await import("@/lib/collective/demo");
  const { parseSnapshot } = await import("@/lib/planner/snapshot");
  const c = await getDemoCollective();
  const order = await svc.createOrder(c.id, { buyerText: "10 scarves", spec: { quantity: 10, deadline: "2026-12-31", budgetUsdCents: null, details: null } });
  const url = `https://haat.test/api/seller/collective/orders/${order.id}?export=evaluation`;
  const context = { params: Promise.resolve({ id: order.id }) };
  assert.equal((await GET(new Request(url), context)).status, 401);
  const cookie = `haat_seller=${await createSessionToken()}`;
  const response = await GET(new Request(url, { headers: { cookie } }), context);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control")!, /private, no-store/);
  assert.match(response.headers.get("content-disposition")!, /attachment/);
  assert.equal(parseSnapshot(await response.json()).source?.orderId, order.id);
  const { o } = await setup(); // another collective is not owned by this coordinator
  assert.equal((await GET(new Request(url, { headers: { cookie } }), { params: Promise.resolve({ id: o.id }) })).status, 404);
});
