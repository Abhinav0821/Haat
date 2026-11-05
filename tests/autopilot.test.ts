import { test } from "node:test";
import assert from "node:assert/strict";
import { CODE_WORDS, matchesCodeWord, pickCodeWord } from "@/lib/autopilot/code-words";
import { normalizeTracking, spellOut, validateTracking } from "@/lib/autopilot/tracking";

test("code word matches Devanagari and common romanisations, as a whole word", () => {
  assert.equal(matchesCodeWord("हाँ, नीला।", "नीला"), true);
  assert.equal(matchesCodeWord("haan neela", "नीला"), true);
  assert.equal(matchesCodeWord("Nila!", "नीला"), true);
  assert.equal(matchesCodeWord("haan de do", "नीला"), false, "a plain yes is not enough");
  assert.equal(matchesCodeWord("neela", "कमल"), false, "the wrong word fails");
});

test("speech-recognition vowel slips still match (the मोर → मूर problem)", () => {
  assert.equal(matchesCodeWord("हा कबूतार", "कबूतर"), true);
  assert.equal(matchesCodeWord("तितलि", "तितली"), true);
  assert.equal(matchesCodeWord("सुरज", "सूरज"), true);
  assert.equal(matchesCodeWord("मकल", "कमल"), false, "consonant order matters");
});

test("no code word can ever approve another code word's challenge", () => {
  for (const a of CODE_WORDS) {
    for (const b of CODE_WORDS) {
      if (a.hi === b.hi) continue;
      for (const form of a.forms) assert.equal(matchesCodeWord(form, b.hi), false, `${form} must not match ${b.hi}`);
    }
  }
});

test("ordinary yes/no phrases never approve a refund", () => {
  const phrases = ["haan", "हाँ", "हाँ दे दो", "ok", "yes please", "ठीक है", "approve", "मंज़ूर", "नहीं"];
  for (const w of CODE_WORDS) for (const p of phrases) assert.equal(matchesCodeWord(p, w.hi), false, `${p} vs ${w.hi}`);
});

test("pickCodeWord never repeats the previous word", () => {
  for (const w of CODE_WORDS) for (let i = 0; i < 20; i++) assert.notEqual(pickCodeWord(w.hi).hi, w.hi);
});

test("tracking numbers are normalised and validated per carrier", () => {
  assert.equal(normalizeTracking("ee 123-456 789 in"), "EE123456789IN");
  assert.deepEqual(validateTracking("india_post", "EE 123 456 789 IN"), { trackingNumber: "EE123456789IN", valid: true });
  assert.equal(validateTracking("india_post", "EE12345678IN").valid, false, "one digit short");
  assert.equal(validateTracking("ups", "1Z999AA10123456784").valid, true);
  assert.equal(validateTracking("dhl", "12345").valid, false);
});

test("tracking numbers are spelled out in small groups for read-back", () => {
  assert.equal(spellOut("EE123456789IN"), "E E, 1 2 3, 4 5 6, 7 8 9, I N");
});
