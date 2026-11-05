import { randomInt } from "node:crypto";

/**
 * Spoken confirmation for money actions.
 *
 * Before a refund runs, the seller must say a random everyday word shown on
 * screen. It proves a live, deliberate "yes" (not an accidental tap, a replayed
 * recording or the AI acting alone). This is intent confirmation, not voice
 * biometrics — we don't claim to identify the speaker.
 */

// Two-to-three-syllable, everyday, visually distinct words: short words like
// "मोर" are easily misheard ("मूर") by speech recognition.
export const CODE_WORDS = [
  { hi: "गुलाब", en: "rose", forms: ["गुलाब", "gulab", "gulaab"] },
  { hi: "तितली", en: "butterfly", forms: ["तितली", "titli", "titali"] },
  { hi: "कबूतर", en: "pigeon", forms: ["कबूतर", "kabutar", "kabootar"] },
  { hi: "बादल", en: "cloud", forms: ["बादल", "badal", "baadal"] },
  { hi: "पीपल", en: "peepal tree", forms: ["पीपल", "peepal", "pipal"] },
  { hi: "सूरज", en: "sun", forms: ["सूरज", "suraj", "sooraj"] },
  { hi: "नीला", en: "blue", forms: ["नीला", "नीली", "neela", "nila", "neelaa"] },
  { hi: "कमल", en: "lotus", forms: ["कमल", "kamal"] },
] as const;

export type CodeWord = (typeof CODE_WORDS)[number];

export function pickCodeWord(exclude?: string): CodeWord {
  const pool = CODE_WORDS.filter((w) => w.hi !== exclude);
  return pool[randomInt(pool.length)];
}

const normalize = (s: string) =>
  s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[।॥.,!?'"“”‘’()-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Consonant skeleton of a Devanagari word: drop vowel signs, nasal marks and
 * nukta, so recognition slips in the vowel ("मोर"→"मूर", "नीला"→"नीली") still match.
 */
export function skeleton(word: string): string {
  return word.normalize("NFD").replace(/[\u0900-\u0903\u093A-\u094F\u0955-\u0957\u0962\u0963]/g, "");
}

/** True if the spoken/typed text contains the code word as a whole word. */
export function matchesCodeWord(heard: string, wordHi: string): boolean {
  const entry = CODE_WORDS.find((w) => w.hi === wordHi);
  if (!entry) return false;
  const tokens = normalize(heard).split(" ").filter(Boolean);
  const exact = new Set(entry.forms.map((f) => normalize(f)));
  if (tokens.some((t) => exact.has(t))) return true;
  // Devanagari: tolerate vowel-sign slips, but require the full consonant pattern (≥2 consonants).
  const target = skeleton(entry.hi);
  return target.length >= 2 && tokens.some((t) => /[\u0900-\u097F]/.test(t) && skeleton(t) === target);
}

export const CHALLENGE_TTL_MS = 5 * 60_000;
export const MAX_ATTEMPTS = 3;
