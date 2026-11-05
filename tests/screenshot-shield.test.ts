import { test } from "node:test";
import assert from "node:assert/strict";
import { damageEvidence, findReusedPhotos, verifyPaymentScreenshots, type AttachmentAnalysis, type CaptureLookup } from "@/lib/shield/attachments";

// Stand-in for PayPal: one real capture exists on this merchant account.
const REAL = { id: "8YT739672Y315064G", amountCents: 3200 };
const paypal: CaptureLookup = async (id) => (id === REAL.id ? { found: true, amountCents: REAL.amountCents, status: "COMPLETED" } : { found: false });
const claim = (amount: number | null, transactionId: string | null) => ({ amount, currency: "USD", transactionId, date: "Nov 5, 2026", recipient: "Meera Block Prints" });
const paidOrder = { amountCents: 3200, status: "COMPLETED", paypalCaptureId: REAL.id };
const unpaidOrder = { amountCents: 3200, status: "CREATED", paypalCaptureId: null };
const codes = async (...args: Parameters<typeof verifyPaymentScreenshots>) => (await verifyPaymentScreenshots(...args)).flags.map((f) => `${f.level}:${f.code}`);

test("a made-up transaction ID is caught", async () => {
  assert.deepEqual(await codes([claim(32, "9XA12345BC6789012")], unpaidOrder, paypal), ["danger:screenshot_txn_not_found"]);
});

test("a real transaction with an edited amount is caught", async () => {
  assert.deepEqual(await codes([claim(320, REAL.id)], paidOrder, paypal), ["danger:screenshot_amount_mismatch"]);
});

test("a real payment shown for the wrong order is flagged", async () => {
  assert.deepEqual(await codes([claim(32, REAL.id)], { ...paidOrder, paypalCaptureId: "OTHERCAPTURE12345" }, paypal), ["caution:screenshot_other_payment"]);
});

test("a genuine screenshot is confirmed by PayPal (no false alarm)", async () => {
  assert.deepEqual(await codes([claim(32, REAL.id)], paidOrder, paypal), ["safe:screenshot_verified"]);
});

test("no transaction ID: the order's real status decides", async () => {
  assert.deepEqual(await codes([claim(32, null)], unpaidOrder, paypal), ["danger:screenshot_order_unpaid"]);
  assert.deepEqual(await codes([claim(32, null)], paidOrder, paypal), ["safe:screenshot_verified"]);
  assert.deepEqual(await codes([claim(32, null)], null, paypal), ["danger:screenshot_without_order"]);
});

test("warnings quote the CLAIMED values but come from fixed templates", async () => {
  const { flags } = await verifyPaymentScreenshots([claim(32, "FAKE1234567890XYZ")], null, paypal);
  assert.match(flags[0].hi, /\$32\.00/);
  assert.match(flags[0].en, /FAKE1234567890XYZ/);
  assert.match(flags[0].en, /don't ship/i);
});

const damaged = (same: "yes" | "no" | "unsure", severity: "minor" | "major" = "minor"): AttachmentAnalysis => ({
  index: 0,
  kind: "product_damage",
  summary: "a torn dupatta",
  payment: null,
  damage: { description: "3 cm tear near the border", severity, sameProductAsListing: same },
});

test("a credible damage photo becomes refund evidence", () => {
  const e = damageEvidence([damaged("yes")], new Set());
  assert.equal(e.hasPhotoEvidence, true);
  assert.match(e.summary!, /tear near the border/);
  assert.deepEqual(e.flags, []);
});

test("a photo of a different product is not evidence and is flagged", () => {
  const e = damageEvidence([damaged("no")], new Set());
  assert.equal(e.hasPhotoEvidence, false);
  assert.equal(e.flags[0].code, "photo_not_this_product");
});

test("a photo reused from another complaint is not evidence and is flagged", () => {
  const e = damageEvidence([damaged("yes")], new Set([0]));
  assert.equal(e.hasPhotoEvidence, false);
  assert.equal(e.flags[0].code, "reused_evidence");
  assert.equal(e.flags[0].level, "danger");
});

test("reused-photo detection uses perceptual distance", () => {
  assert.deepEqual([...findReusedPhotos(["00ff00ff00ff00ff", null, "ffffffffffffffff"], ["00ff00ff00ff00fe"])], [0]);
});

test("a genuine screenshot of an OLD payment can't unlock a new unpaid order", async () => {
  assert.deepEqual(await codes([claim(32, REAL.id)], unpaidOrder, paypal), ["danger:screenshot_other_payment"]);
});

test("pre-sale: a real past payment with no order is still verified as a real payment", async () => {
  assert.deepEqual(await codes([claim(32, REAL.id)], null, paypal), ["safe:screenshot_verified"]);
});
