/**
 * For ADDING a maker language later (see src/lib/i18n/languages.ts): drafts every maker-facing
 * text (src/lib/i18n/maker-source.ts) by machine and writes src/lib/i18n/maker-translations.ts,
 * for a native speaker to review before the language is offered. Not used by the app today.
 *
 *   npx tsx scripts/translate-maker-text.mts --only=ta,te
 *
 * One model call per language (fixed model, no fallback, no automatic retries). Every result
 * is checked in code before it is written: the same {placeholders}, the right script, nothing
 * empty. A language that fails twice is not written. The output stays labelled
 * "machine-translated" in the app until a native speaker reviews it.
 */
import { config } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
config({ path: ".env.local", quiet: true });

const { generateText, Output } = await import("ai");
const { fixedGoogleModel } = await import("@/lib/ai/model");
const { MAKER_SOURCE, PRODUCT_SOURCE } = await import("@/lib/i18n/maker-source");
const SCRIPTS: Record<string, { english: string; name: string; script: RegExp }> = {
  bn: { english: "Bengali", name: "বাংলা", script: /\p{Script=Bengali}/u },
  mr: { english: "Marathi", name: "मराठी", script: /\p{Script=Devanagari}/u },
  te: { english: "Telugu", name: "తెలుగు", script: /\p{Script=Telugu}/u },
  ta: { english: "Tamil", name: "தமிழ்", script: /\p{Script=Tamil}/u },
  gu: { english: "Gujarati", name: "ગુજરાતી", script: /\p{Script=Gujarati}/u },
  ur: { english: "Urdu", name: "اردو", script: /\p{Script=Arabic}/u },
  kn: { english: "Kannada", name: "ಕನ್ನಡ", script: /\p{Script=Kannada}/u },
};
const LANG_INFO = SCRIPTS;
type Lang = "bn" | "mr" | "te" | "ta" | "gu" | "ur" | "kn";
const TARGETS: Lang[] = ["bn", "mr", "te", "ta", "gu", "ur", "kn"];

const OUT = path.join(process.cwd(), "src", "lib", "i18n", "maker-translations.ts");
const only = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1]?.split(",") as Lang[] | undefined;
const existing: Record<string, Record<string, string>> = fs.existsSync(OUT)
  ? JSON.parse(fs.readFileSync(OUT, "utf8").split("export const MAKER_TRANSLATIONS = ")[1].split(" as const;")[0])
  : {};

const keys = Object.keys(MAKER_SOURCE) as (keyof typeof MAKER_SOURCE)[];
const products = Object.keys(PRODUCT_SOURCE);
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
const hasLetters = (s: string) => /\p{L}/u.test(s.replace(/\{\w+\}/g, "").replace(/UPI|₹/g, ""));

function problems(lang: Lang, out: Record<string, string>): string[] {
  const bad: string[] = [];
  const all: [string, string][] = [...keys.map((k) => [k, MAKER_SOURCE[k].en] as [string, string]), ...products.map((p) => [`product:${p}`, p] as [string, string])];
  for (const [k, en] of all) {
    const t = out[k];
    if (typeof t !== "string" || !t.trim()) {
      bad.push(`${k}: missing`);
      continue;
    }
    if (placeholders(t) !== placeholders(en)) bad.push(`${k}: placeholders must be exactly {${placeholders(en)}}`);
    if (hasLetters(en) && !LANG_INFO[lang].script.test(t)) bad.push(`${k}: not written in ${LANG_INFO[lang].english} script`);
  }
  return bad;
}

async function translate(lang: Lang, feedback: string[] = []): Promise<Record<string, string>> {
  const items = [
    ...keys.map((k) => ({ key: k, en: MAKER_SOURCE[k].en, hi: MAKER_SOURCE[k].hi })),
    ...products.map((p) => ({ key: `product:${p}`, en: p, hi: PRODUCT_SOURCE[p as keyof typeof PRODUCT_SOURCE].hi })),
  ];
  const shape = Object.fromEntries(items.map((i) => [i.key, z.string()]));
  const { output } = await generateText({
    model: fixedGoogleModel(process.env.TRANSLATE_MODEL || process.env.GOOGLE_MODEL || "gemini-3.6-flash"),
    temperature: 0,
    maxRetries: 0,
    system: [
      `Translate an app's text into ${LANG_INFO[lang].english} (${LANG_INFO[lang].name}), written in its usual script${lang === "ur" ? " (Urdu Nastaliq/Arabic script)" : lang === "mr" ? " (Devanagari)" : ""}.`,
      "The readers are women artisans in India who make things at home, many with little formal schooling. Use plain, everyday, respectful words, as a neighbour would say them; short sentences; no jargon.",
      "Address the reader as a woman where the language marks gender (the Hindi reference does this).",
      "Keep every {placeholder} exactly as written, untranslated. Keep ₹, UPI, numbers and the app name Haat as they are.",
      "Some texts are terms she agrees to (keys starting rb. and terms.): translate their meaning completely and exactly; do not add or drop any condition.",
      "Each item has the English source and the reviewed Hindi version for meaning and tone. Return one translation per key.",
    ].join(" "),
    prompt: `${feedback.length ? `Fix these problems from your previous answer:\n${feedback.join("\n")}\n\n` : ""}${JSON.stringify(items)}`,
    output: Output.object({ schema: z.object(shape), name: "translations" }),
  });
  return output as Record<string, string>;
}

const result: Record<string, Record<string, string>> = { ...existing };
for (const lang of only ?? TARGETS) {
  let out = await translate(lang);
  let bad = problems(lang, out);
  if (bad.length) {
    console.warn(`${lang}: ${bad.length} problem(s); asking once more`);
    out = await translate(lang, bad);
    bad = problems(lang, out);
  }
  if (bad.length) {
    console.error(`${lang}: still ${bad.length} problem(s) — not written:\n  ${bad.slice(0, 8).join("\n  ")}`);
    process.exitCode = 1;
    continue;
  }
  result[lang] = out;
  console.log(`${lang}: ${Object.keys(out).length} texts, all checks passed`);
}
const header = `/**\n * GENERATED by scripts/translate-maker-text.ts from maker-source.ts — machine translation,\n * labelled as such to makers until a native speaker reviews it. Every entry was checked for\n * exact {placeholders} and the language's script before it was written.\n */\n`;
fs.writeFileSync(OUT, `${header}export const MAKER_TRANSLATIONS = ${JSON.stringify(result, null, 1)} as const;\n`);
console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
