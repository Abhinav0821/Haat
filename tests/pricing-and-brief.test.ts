import { test } from "node:test";
import assert from "node:assert/strict";
import { composeBrief, type BriefNumbers } from "@/lib/brief";
import { analyzeFairPrice, selectComparables, type Comparable } from "@/lib/pricing/fair-price";

const item = (title: string, dollars: number): Comparable => ({
  title,
  priceCents: dollars * 100,
  domain: "shop.example",
  url: `https://shop.example/${encodeURIComponent(title)}`,
  image: null,
});

// Shaped like the real Channel3 results for "hand block printed cotton dupatta".
const channel3Like = [
  item("Jaipur Hand Block Printed Cotton Throw", 200),
  item("Baadal Hand Block Printed Cotton Bandana", 40),
  item("Cotton Percale Hand Block Printed Duvet Set", 180),
  item("Block-Printed Scarf Set", 72),
  item("Mud-Block-Printed Scarf", 98),
  item("Hand Block Printed Napkins - Set of 4", 65),
  item("Indigo Cotton Dupatta", 48),
  item("Hand Block Print Stole", 55),
  item("Kantha Silk Scarf", 1200), // outlier
];

test("only the same kind of item is compared (no duvets, napkins or throws)", () => {
  const comps = selectComparables(channel3Like, ["dupatta", "scarf", "stole"]);
  const titles = comps.map((c) => c.title);
  assert.ok(titles.every((t) => /dupatta|scarf|stole/i.test(t)), titles.join(", "));
  assert.ok(!titles.some((t) => /duvet|napkin|throw/i.test(t)));
  assert.ok(!titles.includes("Kantha Silk Scarf"), "price outlier removed");
});

test("duplicate listings (variants) are counted once", () => {
  const dupes = [item("Hand Blocked Scarf", 78), item("Hand Blocked Scarf", 78), item("Hand Blocked Scarf", 78), item("Silk Scarf", 60)];
  assert.equal(selectComparables(dupes, ["scarf"]).length, 2);
});

test("an under-priced artisan gets a conservative suggestion, explained in Hindi", () => {
  const comps = selectComparables(channel3Like, ["dupatta", "scarf", "stole"]);
  const fp = analyzeFairPrice(comps, 909)!; // ₹800 ≈ $9.09
  assert.equal(fp.verdict, "under");
  assert.ok(fp.suggestedCents! >= fp.lowCents - 100 && fp.suggestedCents! <= fp.medianCents, "suggests the low end, not the top");
  assert.match(fp.hi, /बहुत कम/);
  assert.equal(fp.examples.length, 3);
});

test("a fair price is left alone; an above-range price is only noted", () => {
  const comps = [item("Scarf A", 40), item("Scarf B", 50), item("Scarf C", 60), item("Scarf D", 70)];
  assert.equal(analyzeFairPrice(comps, 5500)!.verdict, "fair");
  assert.equal(analyzeFairPrice(comps, 5500)!.suggestedCents, null);
  const over = analyzeFairPrice(comps, 15000)!;
  assert.equal(over.verdict, "over");
  assert.equal(over.suggestedCents, null, "never pushes a price down");
});

test("not enough evidence → no advice", () => {
  assert.equal(analyzeFairPrice([item("Scarf A", 40), item("Scarf B", 50)], 900), null);
});

const base: BriefNumbers = {
  ownerName: "मीरा",
  paidOrders: 0,
  grossCents: 0,
  feeCents: 0,
  netCents: 0,
  refundedCents: 0,
  toShip: 0,
  pendingApprovals: 0,
  unanswered: 0,
  scamWarnings: 0,
  inrPerUsd: 88,
};

test("brief reports PayPal fees and net in dollars and rupees", () => {
  const b = composeBrief({ ...base, paidOrders: 2, grossCents: 6400, feeCents: 270, netCents: 6130 });
  assert.match(b.hi, /2 ऑर्डर आए/);
  assert.match(b.hi, /2\.70 डॉलर/);
  assert.match(b.hi, /61\.30 डॉलर/);
  assert.match(b.hi, /5,394 रुपये/);
  assert.match(b.en, /\$61\.30 to you/);
});

test("brief puts scam warnings and pending work in front of the seller", () => {
  const b = composeBrief({ ...base, scamWarnings: 2, pendingApprovals: 1, toShip: 3, unanswered: 4 });
  assert.match(b.hi, /सावधान, 2 संदेशों/);
  assert.match(b.hi, /1 रिफ़ंड पर आपकी मंज़ूरी/);
  assert.match(b.hi, /3 ऑर्डर भेजने बाकी/);
  assert.doesNotMatch(b.hi, /बाकी सब ठीक है/);
});

test("a quiet day says so", () => {
  const b = composeBrief(base);
  assert.match(b.hi, /कोई नया ऑर्डर नहीं/);
  assert.match(b.hi, /बाकी सब ठीक है/);
});
