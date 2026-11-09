import { MAKER_SOURCE, type MakerKey } from "./maker-source";
import { fill, type MakerLang } from "./languages";

/** A maker-facing text in her language. */
export function mt(key: MakerKey, lang: MakerLang, vars?: Record<string, string | number>): string {
  const src = MAKER_SOURCE[key];
  return fill(lang === "en" ? src.en : src.hi, vars);
}

/** The product's name in her language. */
export function productName(product: { en: string; hi: string }, lang: MakerLang): string {
  return lang === "en" ? product.en : product.hi;
}
