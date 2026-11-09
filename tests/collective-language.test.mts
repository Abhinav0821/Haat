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
const { makerView } = await import("@/lib/collective/views");
const { partTerms, hashOf, partReadback, hasRequirementsFor } = await import("@/lib/collective/terms");
const { mt } = await import("@/lib/i18n/maker-text");
const { MAKER_SOURCE } = await import("@/lib/i18n/maker-source");
const { CollectiveError, offerPlan, respondToPart, createOrder, updateMemberFacts, setMemberLanguage } = svc;

/** A maker's language: her page, her read-back and the terms she agrees to. Hindi terms are unchanged. */

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
beforeEach(async () => {
  s = await seedCollective(await db(), { slug: `lang-${process.pid}-${++n}`, at: later(-24) });
  for (const m of DEMO_MEMBERS) await updateMemberFacts(idOf(m.name), m.facts, { source: "maker_confirmed", name: m.name }, later(-1));
});

async function partsOf(planId: string) {
  const d = await db();
  const [p] = await d.select().from(schema.collectivePlans).where(eq(schema.collectivePlans.id, planId));
  const refs = (p.terms as { parts: { memberId: string; partId: string; termsHash: string }[] }).parts;
  const rows = await d.select().from(schema.memberParts);
  return refs.map((r) => ({ ...r, row: rows.find((x) => x.id === r.partId)!, name: s.members.find((m) => m.id === r.memberId)!.name }));
}

test("every maker text exists in English and Hindi with the same placeholders", () => {
  const ph = (x: string) => [...x.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  for (const [k, v] of Object.entries(MAKER_SOURCE)) {
    assert.ok(v.en.trim() && v.hi.trim(), k);
    assert.equal(ph(v.hi), ph(v.en), `${k}: placeholders differ`);
  }
  assert.equal(mt("greeting", "en", { name: "Meera" }), "Hello Meera");
  assert.equal(mt("greeting", "hi", { name: "मीरा" }), "नमस्ते मीरा");
});

test("a Hindi maker's terms and hash are exactly as before; an English-reading maker's terms are in English", async () => {
  const plan = { quantity: 2, deliveryDay: 20, lastFinishDay: 11, production: [{ makerId: "m1", day: 2, pieces: 2 }], finishing: [{ day: 4, pieces: 2 }], money: { perMaker: [{ makerId: "m1", pieces: 2, payInr: 840 }] } } as never;
  const ctx = { collective: "C", orderRef: "abcd1234", product: { en: "scarf", hi: "दुपट्टा" }, details: "indigo", detailsHi: "नीला", transitDays: 7 };
  const before = partTerms(plan, "2026-11-08", "m1", ctx)!;
  const hindi = partTerms(plan, "2026-11-08", "m1", { ...ctx, langs: { m1: "hi" } })!;
  assert.equal(hashOf(hindi), hashOf(before), "Hindi terms are byte-identical to terms made before languages existed");
  assert.equal(partReadback(hindi), partReadback(before));
  const english = partTerms(plan, "2026-11-08", "m1", { ...ctx, langs: { m1: "en" } })!;
  assert.equal(english.lang, "en");
  assert.notEqual(hashOf(english), hashOf(before), "her language is part of what she agrees to");
  const rb = partReadback(english);
  for (const clause of ["C order, scarf.", "Special requirements: indigo.", "Your part is 2 pieces", "₹420 per piece, ₹840 in all.", "the collective owes you ₹840", "Start only after this page says the buyer has paid."]) assert.ok(rb.includes(clause), `${clause} — ${rb}`);
  assert.ok(!/\p{Script=Devanagari}/u.test(rb), "English read-back contains no Hindi");
  assert.equal(hasRequirementsFor(english), true, "she reads the buyer's English directly");
  assert.equal(hasRequirementsFor(partTerms(plan, "2026-11-08", "m1", { ...ctx, detailsHi: null })!), false, "a Hindi maker needs the Hindi");
});

test("language choice: makers who chose English get English parts and can accept without a Hindi reading; Hindi makers still need it", async () => {
  const o = await createOrder(s.collective.id, { buyerText: "60 scarves", spec: { quantity: 60, deadline: "2026-11-30", budgetUsdCents: null, details: "indigo", detailsHi: null } });
  // All three makers are needed for 60 by Nov 30; while any of them reads Hindi, the Hindi is required.
  await setMemberLanguage(idOf("Meera"), "en");
  await assert.rejects(offerPlan(o.id, "primary", NOW), (e: unknown) => e instanceof CollectiveError && /Hindi/.test(e.message));
  await setMemberLanguage(idOf("Sunita"), "en");
  await setMemberLanguage(idOf("Rukhsana"), "en");
  const plan = await offerPlan(o.id, "primary", NOW);
  for (const p of await partsOf(plan.id)) {
    const view = await makerView(tokenOf(p.name), NOW);
    const mine = view.parts.find((x) => x.id === p.partId)!;
    assert.equal(view.language, "en");
    assert.equal(mine.termsLang, "en");
    assert.equal(mine.requirementsReady, true);
    assert.match(mine.readback, /Special requirements: indigo\./);
    await respondToPart(tokenOf(p.name), p.partId, p.termsHash, "accept", null, NOW);
  }
});

test("switching language never rewrites a part already sent; the next version is in her new language", async () => {
  const o = await createOrder(s.collective.id, { buyerText: "60 scarves", spec: { quantity: 60, deadline: "2026-11-30", budgetUsdCents: null, details: null } });
  const plan = await offerPlan(o.id, "primary", NOW);
  const [first] = await partsOf(plan.id);
  await setMemberLanguage(first.memberId, "en");
  const view = await makerView(tokenOf(first.name), NOW);
  const part = view.parts.find((x) => x.id === first.partId)!;
  assert.equal(view.language, "en");
  assert.equal(part.termsLang, "hi", "the part she was sent is unchanged");
  assert.equal(part.termsHash, first.termsHash);
  // The coordinator re-sends: only her part changes (a new version, asked again, in English).
  const again = await offerPlan(o.id, "primary", later(1));
  const after = await partsOf(again.id);
  const hers = after.find((x) => x.memberId === first.memberId)!;
  assert.notEqual(hers.partId, first.partId);
  assert.equal((hers.row.terms as { lang?: string }).lang, "en");
  for (const other of after.filter((x) => x.memberId !== first.memberId)) assert.equal(other.partId, (await partsOf(plan.id)).find((x) => x.memberId === other.memberId)!.partId, "others keep their part");
  await assert.rejects(setMemberLanguage(first.memberId, "fr"), (e: unknown) => e instanceof CollectiveError && e.status === 400);
});

test("AI Hindi draft: checked for script, with an independent back-translation; never saved by itself", async () => {
  const { MockLanguageModelV4 } = await import("ai/test");
  const { draftRequirements } = await import("@/lib/ai/requirements");
  const reply = (text: string) => ({ content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] });
  const calls: string[] = [];
  const good = new MockLanguageModelV4({
    doGenerate: async (opts) => {
      const prompt = JSON.stringify(opts.prompt);
      calls.push(prompt);
      return calls.length === 1 ? reply(JSON.stringify({ hi: "नीला रंग, 2 मीटर" })) : reply(JSON.stringify({ hi: "Blue colour, 2 metres" }));
    },
  });
  const ok = await draftRequirements("indigo, exactly 2 metres", ["hi"], { model: good });
  assert.equal(ok.drafts[0].text, "नीला रंग, 2 मीटर");
  assert.equal(ok.drafts[0].back, "Blue colour, 2 metres");
  assert.ok(!calls[1].includes("exactly 2 metres"), "the back-translation never sees the original English");
  const latin = new MockLanguageModelV4({ doGenerate: async () => reply(JSON.stringify({ hi: "neela rang" })) });
  const bad = await draftRequirements("indigo", ["hi"], { model: latin });
  assert.equal(bad.drafts[0].text, null);
  assert.match(bad.drafts[0].problem ?? "", /Hindi/);
});
