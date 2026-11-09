/**
 * The languages a maker can use Haat in: Hindi (default) and English, both written and
 * reviewed by us.
 *
 * Preference: a maker's language is stored on her record (set by the coordinator, changed by
 * her at any time on her own page). Her page, her read-back and the terms she agrees to use it.
 *
 * Adding a language: add it to MAKER_LANGS and LANG_INFO, run scripts/translate-maker-text.mts
 * for a machine draft (checked in code for placeholders and script), then have a native speaker
 * review it before setting `reviewed: true`. Unreviewed languages are labelled as such to makers.
 */

export const MAKER_LANGS = ["hi", "en"] as const;
export type MakerLang = (typeof MAKER_LANGS)[number];

export type LangInfo = {
  /** The language's own name, as she would recognise it. */
  name: string;
  english: string;
  locale: string;
  dir: "ltr" | "rtl";
  /** Text in this language must contain this script (used to check requirement translations). */
  script: RegExp;
  /** Name understood by the read-aloud helper. */
  speech: string;
  reviewed: boolean;
};

export const LANG_INFO: Record<MakerLang, LangInfo> = {
  hi: { name: "हिंदी", english: "Hindi", locale: "hi-IN", dir: "ltr", script: /\p{Script=Devanagari}/u, speech: "hindi", reviewed: true },
  en: { name: "English", english: "English", locale: "en-IN", dir: "ltr", script: /\p{Script=Latin}/u, speech: "english", reviewed: true },
};

export const isMakerLang = (x: unknown): x is MakerLang => typeof x === "string" && (MAKER_LANGS as readonly string[]).includes(x);

/** Dates in her language, with Latin digits (the same digits as amounts and phone numbers). */
export function longDay(iso: string, lang: MakerLang): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString(`${LANG_INFO[lang].locale}-u-nu-latn`, { day: "numeric", month: "long", timeZone: "UTC" });
}

export const rupeesText = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** Fill {placeholders}. Missing values are left visible rather than silently dropped. */
export function fill(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
