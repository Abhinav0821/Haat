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
const { seedCollective, DEMO_MEMBERS, demoSettings } = await import("@/lib/collective/seed");
const { buyerView, makerView, internalView } = await import("@/lib/collective/views");
const { CollectiveError, offerPlan, respondToPart, buyerApprove, createOrder, activeReservations, currentPlan, excludeMember, updateMemberFacts } = svc;

const NOW = new Date("2026-11-07T09:00:00Z");
const later = (h: number) => new Date(NOW.getTime() + h * 3600_000);
type Seeded = Awaited<ReturnType<typeof seedCollective>>;
let n = 0;
let s: Seeded;
const tokenOf = (name: string) => s.members.find((m) => m.name === name)!.token;
const idOf = (name: string) => s.members.find((m) => m.name === name)!.id;

before(async () => {
  await db();
});
after(async () => closeDb());

/** A fresh collective per test; makers have confirmed their facts on their links. */
beforeEach(async () => {
  const d = await db();
  s = await seedCollective(d, { slug: `test-${process.pid}-${++n}`, at: later(-24) });
  for (const m of DEMO_MEMBERS) {
    await updateMemberFacts(idOf(m.name), m.facts, { source: "maker_confirmed", name: m.name }, later(-1));
  }
});

const order = (quantity = 60, deadline = "2026-11-30", budgetUsdCents: number | null = null) =>
  createOrder(s.collective.id, { buyerText: `${quantity} scarves by ${deadline}`, buyerName: "Test Buyer", spec: { quantity, deadline, budgetUsdCents, details: "indigo", detailsHi: "नीला रंग" } });

async function parts(planId: string) {
  const d = await db();
  const [p] = await d.select().from(schema.collectivePlans).where(eq(schema.collectivePlans.id, planId));
  const refs = (p.terms as { parts: { memberId: string; partId: string; termsHash: string }[] }).parts;
  const rows = await d.select().from(schema.memberParts);
  return refs.map((r) => ({ ...r, row: rows.find((x) => x.id === r.partId)!, name: s.members.find((m) => m.id === r.memberId)!.name }));
}
async function acceptAll(planId: string, at = NOW) {
  for (const p of await parts(planId)) if (p.row.status === "pending") await respondToPart(tokenOf(p.name), p.partId, p.termsHash, "accept", null, at);
}
const reservedPieces = async (at = NOW) => {
  const rs = await activeReservations(await db(), s.collective.id, at);
  return { production: rs.flatMap((r) => r.production).reduce((x, p) => x + p.pieces, 0), finishing: rs.flatMap((r) => r.finishing).reduce((x, f) => x + f.pieces, 0) };
};
const rejects = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: unknown) => e instanceof CollectiveError && re.test(e.message));

test("three makers: each gets only her own part; the buyer can approve only after every maker accepts on her own link", async () => {
  const o = await order();
  const plan = await offerPlan(o.id, "primary", NOW);
  assert.equal(plan.status, "awaiting_makers");
  const ps = await parts(plan.id);
  assert.equal(ps.length, 3, "all three makers are needed for 60 by Nov 30");
  await rejects(buyerApprove(plan.id, plan.termsHash, NOW), /Not every maker/);

  // Two accept; still not approvable.
  await respondToPart(tokenOf(ps[0].name), ps[0].partId, ps[0].termsHash, "accept", null, NOW);
  await respondToPart(tokenOf(ps[1].name), ps[1].partId, ps[1].termsHash, "accept", null, NOW);
  await rejects(buyerApprove(plan.id, plan.termsHash, NOW), /Not every maker/);
  assert.equal((await buyerView(o.id, NOW)).offer?.makersConfirmed, 2);

  await respondToPart(tokenOf(ps[2].name), ps[2].partId, ps[2].termsHash, "accept", null, NOW);
  assert.equal((await currentPlan(await db(), o.id, NOW))!.status, "ready");
  const approved = await buyerApprove(plan.id, plan.termsHash, NOW);
  assert.equal(approved.status, "approved");
  assert.deepEqual(await reservedPieces(), { production: 60, finishing: 60 });
});

test("a link answers only its own maker's part, and only for the exact terms she saw", async () => {
  const o = await order();
  const plan = await offerPlan(o.id, "primary", NOW);
  const [a, b] = await parts(plan.id);
  await rejects(respondToPart(tokenOf(a.name), b.partId, b.termsHash, "accept", null, NOW), /wasn't found/);
  await rejects(respondToPart(tokenOf(a.name), a.partId, "0".repeat(64), "accept", null, NOW), /terms changed/);
  await rejects(respondToPart("x".repeat(32), a.partId, a.termsHash, "accept", null, NOW), /link isn't valid/);
  const rows = await (await db()).select().from(schema.members).where(eq(schema.members.collectiveId, s.collective.id));
  assert.ok(rows.every((m) => !s.members.some((x) => x.token === m.linkHash)), "only hashes of links are stored");
});

test("acceptance recorded any other way than her own link does not count", async () => {
  const o = await order();
  const plan = await offerPlan(o.id, "primary", NOW);
  const d = await db();
  for (const p of await parts(plan.id)) {
    await d.update(schema.memberParts).set({ status: "accepted", respondedHash: p.termsHash, respondedAt: NOW, respondedVia: "coordinator" }).where(eq(schema.memberParts.id, p.partId));
  }
  await d.update(schema.collectivePlans).set({ status: "ready" }).where(eq(schema.collectivePlans.id, plan.id));
  await rejects(buyerApprove(plan.id, plan.termsHash, NOW), /Not every maker/);
  assert.deepEqual(await reservedPieces(), { production: 0, finishing: 0 });
});

test("re-planning: unchanged parts keep her acceptance; a changed part is a new version she must accept again", async () => {
  const o = await order();
  const v1 = await offerPlan(o.id, "primary", NOW);
  await acceptAll(v1.id);

  // Same facts → every part reused with its acceptance; a new plan version the buyer must approve.
  const v2 = await offerPlan(o.id, "primary", NOW);
  assert.equal(v2.version, 2);
  assert.equal(v2.status, "ready");
  const p1 = await parts(v1.id);
  const p2 = await parts(v2.id);
  assert.deepEqual(p2.map((p) => p.partId), p1.map((p) => p.partId));
  await rejects(buyerApprove(v1.id, v1.termsHash, NOW), /replaced by a newer version/);

  // Rukhsana raises her asking price: her pay changes, so her part is new and pending.
  await updateMemberFacts(idOf("Rukhsana"), { ...DEMO_MEMBERS[2].facts, askInr: 470 }, { source: "maker_confirmed", name: "Rukhsana" }, NOW);
  const v3 = await offerPlan(o.id, "primary", NOW);
  assert.equal(v3.status, "awaiting_makers");
  const p3 = await parts(v3.id);
  for (const p of p3) {
    const before = p2.find((x) => x.memberId === p.memberId);
    if (before && before.termsHash === p.termsHash) assert.equal(p.partId, before.partId, `${p.name}: unchanged part reused`);
    else assert.equal(p.row.status, "pending", `${p.name}: changed part asked again`);
  }
  const ruk = p3.find((p) => p.name === "Rukhsana")!;
  assert.equal(ruk.row.status, "pending");
  assert.equal(ruk.row.version, 2);
  const old = p2.find((p) => p.name === "Rukhsana")!;
  const [oldRow] = await (await db()).select().from(schema.memberParts).where(eq(schema.memberParts.id, old.partId));
  assert.equal(oldRow.status, "superseded");
  await rejects(respondToPart(tokenOf("Rukhsana"), old.partId, old.termsHash, "accept", null, NOW), /was changed/);
  const reasked = p3.filter((p) => p.row.status === "pending").map((p) => p.name);
  console.log(`  re-asked after Rukhsana's price change: ${reasked.join(", ")} (of ${p3.length})`);
});

test("two orders can't both reserve the same finishing capacity", async () => {
  // Each order fits alone; together they exceed finishing before the deadline.
  const a = await order(50);
  const b = await order(50);
  const pa = await offerPlan(a.id, "primary", NOW);
  const pb = await offerPlan(b.id, "primary", NOW);
  await acceptAll(pa.id);
  await acceptAll(pb.id);
  const results = await Promise.allSettled([buyerApprove(pa.id, pa.termsHash, NOW), buyerApprove(pb.id, pb.termsHash, NOW)]);
  const ok = results.filter((r) => r.status === "fulfilled");
  assert.equal(ok.length, 1, "exactly one reservation succeeds");
  const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.match(failed.reason.message, /schedule changed/);
  assert.deepEqual(await reservedPieces(), { production: 50, finishing: 50 });

  // The loser is marked for re-planning; re-planning sees the other order's hold.
  const loser = ok[0] === results[0] ? b : a;
  assert.equal((await currentPlan(await db(), loser.id, NOW))!.status, "needs_replan");
  const view = await internalView(loser.id, NOW);
  assert.equal(view.evaluation.kind, "infeasible_capacity");
  assert.equal(view.evaluation.checked, true);
  const best = await offerPlan(loser.id, "largest_by_date", NOW);
  assert.ok((best.plan as { quantity: number }).quantity < 50);
});

test("a maker saying no releases the hold; she is left out only by an explicit coordinator step", async () => {
  const o = await order(25);
  const v1 = await offerPlan(o.id, "primary", NOW);
  await acceptAll(v1.id);
  await buyerApprove(v1.id, v1.termsHash, NOW);
  assert.equal((await reservedPieces()).production, 25);

  const mine = (await parts(v1.id)).find((p) => p.name === "Meera")!;
  await rejects(excludeMember(o.id, idOf("Sunita")), /Only a maker who said no/);
  await respondToPart(tokenOf("Meera"), mine.partId, mine.termsHash, "decline", "My materials are late", NOW);
  assert.equal((await currentPlan(await db(), o.id, NOW))!.status, "maker_declined");
  assert.deepEqual(await reservedPieces(), { production: 0, finishing: 0 });
  assert.equal((await buyerView(o.id, NOW)).revising, true);
  await rejects(buyerApprove(v1.id, v1.termsHash, NOW), /being revised/);

  await excludeMember(o.id, idOf("Meera"));
  const v2 = await offerPlan(o.id, "primary", NOW);
  const p2 = await parts(v2.id);
  assert.ok(p2.every((p) => p.name !== "Meera"));
  assert.ok((await internalView(o.id, NOW)).excluded.includes("Meera"));
});

test("an unpaid hold lapses: capacity is released and the buyer's approval re-checks", async () => {
  // Work must still be in the future when the buyer renews two days later.
  for (const m of DEMO_MEMBERS) await updateMemberFacts(idOf(m.name), { ...m.facts, materialsReadyDate: "2026-11-15" }, { source: "maker_confirmed", name: m.name }, NOW);
  const o = await order(25);
  const v1 = await offerPlan(o.id, "primary", NOW);
  await acceptAll(v1.id);
  await buyerApprove(v1.id, v1.termsHash, NOW);
  const t = later(49);
  assert.equal((await reservedPieces(t)).production, 0);
  assert.equal((await currentPlan(await db(), o.id, t))!.status, "ready");
  assert.equal((await buyerApprove(v1.id, v1.termsHash, t)).status, "approved");
});

test("a fact that changes after the makers accept is caught when the buyer approves; nothing is reserved", async () => {
  const o = await order(25);
  const v1 = await offerPlan(o.id, "primary", NOW);
  await acceptAll(v1.id);
  const used = (await parts(v1.id)).map((p) => p.name);
  const who = used[0];
  const f = DEMO_MEMBERS.find((m) => m.name === who)!.facts;
  await updateMemberFacts(idOf(who), { ...f, piecesPerWeekday: [0, 0, 0, 0, 0, 0, 0] }, { source: "maker_confirmed", name: who }, NOW);
  await rejects(buyerApprove(v1.id, v1.termsHash, NOW), /being revised/);
  assert.equal((await currentPlan(await db(), o.id, NOW))!.status, "needs_replan");
  assert.deepEqual(await reservedPieces(), { production: 0, finishing: 0 });
});

test("views: the buyer sees no maker's name, pay, minimum or availability; a maker sees only her own part", async () => {
  const o = await order();
  const v1 = await offerPlan(o.id, "primary", NOW);
  const bv = JSON.stringify(await buyerView(o.id, NOW));
  for (const m of DEMO_MEMBERS) assert.ok(!bv.includes(m.name), `buyer view mentions ${m.name}`);
  assert.doesNotMatch(bv, /askInr|floorInr|payInr|₹|piecesPerWeekday|commitments/);

  const mv = await makerView(tokenOf("Sunita"), NOW);
  assert.equal(mv.parts.length, 1);
  const mvText = JSON.stringify(mv);
  for (const other of ["Meera", "Rukhsana"]) assert.ok(!mvText.includes(other));
  const others = (await parts(v1.id)).filter((p) => p.name !== "Sunita");
  for (const p of others) assert.ok(!mvText.includes(`₹${(p.row.terms as { payInr: number }).payInr.toLocaleString("en-IN")}`) || (p.row.terms as { payInr: number }).payInr === mv.parts[0].payInr);
  assert.match(mv.parts[0].readback, /आपका हिस्सा \d+ पीस/);
});

test("coordinator-entered facts are planned as estimates, labelled as such", async () => {
  const d = await db();
  const s2 = await seedCollective(d, { slug: `estimates-${process.pid}-${n}`, at: later(-24), settings: demoSettings(later(-24).toISOString()) });
  const o = await createOrder(s2.collective.id, { buyerText: "25 scarves", spec: { quantity: 25, deadline: "2026-11-30", budgetUsdCents: null, details: null } });
  const v = await internalView(o.id, NOW);
  assert.equal(v.evaluation.kind, "feasible");
  assert.ok(v.makers.every((m) => !m.confirmed && /estimate/.test(m.source)));
  assert.ok(v.evaluation.notes.some((x) => /entered by the coordinator/.test(x.en)));
});

test("an approved order's own hold is not counted against it; plans never ask for work on a day already under way", async () => {
  const o = await order();
  const v1 = await offerPlan(o.id, "primary", NOW);
  const days = (v1.plan as { production: { day: number }[] }).production.map((p) => p.day);
  assert.equal((v1.facts as { startDate: string }).startDate, "2026-11-08", "a plan made on Nov 7 starts on Nov 8");
  assert.ok(days.every((t) => t >= 0));
  // A second order, offered now but approved a day later: its first work day has started by then.
  const late = await order(10);
  const p = await offerPlan(late.id, "primary", NOW);
  await acceptAll(p.id);
  // Its first work day (Sunita's, once her materials arrive) is Nov 13; approving a week later must be refused.
  const first = Math.min(...(p.plan as { production: { day: number }[] }).production.map((x) => x.day));
  await rejects(buyerApprove(p.id, p.termsHash, later(24 * (first + 2))), /schedule changed/);

  await acceptAll(v1.id);
  await buyerApprove(v1.id, v1.termsHash, NOW);
  const v = await internalView(o.id, NOW);
  assert.equal(v.evaluation.kind, "feasible", "re-checking the approved order must not collide with its own reservation");
});

test("her read-back merges consecutive days with the same count", async () => {
  const { runs } = await import("@/lib/collective/terms");
  assert.deepEqual(runs([{ date: "2026-11-09", pieces: 3 }, { date: "2026-11-10", pieces: 3 }, { date: "2026-11-11", pieces: 3 }, { date: "2026-11-13", pieces: 3 }, { date: "2026-11-14", pieces: 2 }]), [
    { from: "2026-11-09", to: "2026-11-11", pieces: 3 },
    { from: "2026-11-13", to: "2026-11-13", pieces: 3 },
    { from: "2026-11-14", to: "2026-11-14", pieces: 2 },
  ]);
});
