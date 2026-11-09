import { z } from "zod";
import { isCalendarDate } from "@/lib/calendar-date";

/**
 * Buyer request intake (docs/direction.md §A). The AI proposes a reading of the buyer's
 * words; THIS code decides what that reading may contain and how sure it is:
 *
 *  - Only the buyer's own request fields exist here: quantity, delivery date, budget,
 *    a short description. Maker availability, materials, prices and payment terms
 *    cannot be expressed by this schema at all.
 *  - Grounding: a number the AI returns that does not occur in the buyer's words is an
 *    assumption to confirm, never "stated". A date counts as stated only when the
 *    buyer's own words parse to that date here, without the model.
 *  - Missing or unusable values stay empty with a question.
 *
 * Nothing is planned from an interpretation; only requirements the buyer confirms are.
 */

/** What the model may return. Untrusted: every field is re-checked below. */
export const HeardSchema = z.object({
  quantity: z.number().nullable().describe("Number of pieces the buyer asks for, or null if they don't say."),
  quantityWords: z.string().nullable().describe("The buyer's exact words giving the quantity, copied from the text, or null."),
  deliverBy: z.string().nullable().describe("Date the buyer needs DELIVERY by, as YYYY-MM-DD, resolved against today's date. null if none."),
  deliverByWords: z.string().nullable().describe("The buyer's exact words giving the date, copied from the text (e.g. 'by Dec 10', 'before Christmas'), or null."),
  budget: z
    .object({ amount: z.number(), currency: z.enum(["USD", "INR", "OTHER"]), basis: z.enum(["total", "per_piece"]) })
    .nullable()
    .describe("The budget, if the buyer states one. currency OTHER for anything but US dollars or Indian rupees."),
  budgetWords: z.string().nullable().describe("The buyer's exact words giving the budget, copied from the text, or null."),
  item: z.string().nullable().describe("What the buyer wants made, in a few English words, e.g. 'block-printed scarves'."),
  matchesProduct: z.enum(["yes", "no", "unclear"]).describe("Whether the request is for the collective's product."),
  details: z.string().nullable().describe("Colours, size, pattern, packaging or other requirements, in one short English sentence. null if none."),
  unclear: z.array(z.string()).describe("Short questions about anything the buyer should clarify. Empty if nothing."),
});
export type Heard = z.infer<typeof HeardSchema>;

export type FieldStatus = "stated" | "assumed" | "missing";
export type Field<T> = { value: T | null; status: FieldStatus; words: string | null; note: string | null };

export type Interpretation = {
  quantity: Field<number>;
  deadline: Field<string>;
  budgetUsdCents: Field<number>;
  details: Field<string>;
  product: { matches: "yes" | "no" | "unclear"; asked: string | null; note: string | null };
  questions: string[];
};

export const MAX_QUANTITY = 10_000;

/** "scarf" → "scarves", "cushion cover" → "cushion covers". */
export const plural = (noun: string) => (/[^f]f$/.test(noun) ? `${noun.slice(0, -1)}ves` : /fe$/.test(noun) ? `${noun.slice(0, -2)}ves` : `${noun}s`);

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/**
 * Every number written in the text: digits (1,200 · 1.5k · $250) and English number
 * words up to the thousands ("thirty", "two hundred and fifty", "a dozen", "three dozen").
 */
export function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  const t = text.toLowerCase();
  for (const m of t.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(k\b|thousand\b|lakh\b|lakhs\b)?/g)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    const mult = m[2] === "k" || m[2] === "thousand" ? 1000 : m[2]?.startsWith("lakh") ? 100_000 : 1;
    out.add(n * mult);
    if (mult !== 1) out.add(n);
  }
  const words = t.replace(/-/g, " ").split(/[^a-z]+/).filter(Boolean);
  let current: number | null = null;
  let total = 0;
  const flush = () => {
    if (current !== null || total) out.add(total + (current ?? 0));
    current = null;
    total = 0;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w in UNITS) current = (current ?? 0) + UNITS[w];
    else if (w in TENS) current = (current ?? 0) + TENS[w];
    else if (w === "hundred" && current !== null) current *= 100;
    else if (w === "thousand" && current !== null) {
      total += current * 1000;
      current = 0;
    } else if (w === "dozen") {
      out.add((current ?? 1) * 12);
      current = null;
      total = 0;
    } else if (w === "and" && current !== null) continue;
    else if (w === "a" && words[i + 1] === "dozen") continue;
    else flush();
  }
  flush();
  return out;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * A date written explicitly in the buyer's words, resolved to its next occurrence on or
 * after `today` when the year is omitted. Holidays and relative phrases ("in 3 weeks",
 * "before Christmas") are deliberately NOT parsed: they stay assumptions to confirm.
 */
export function explicitDate(words: string, today: string): string | null {
  const w = words.toLowerCase();
  const iso = w.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return isCalendarDate(iso[0]) ? iso[0] : null;
  const monthIdx = (s: string) => MONTHS.indexOf(s.slice(0, 3));
  let day: number | null = null;
  let month = -1;
  let year: number | null = null;
  const a = w.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/);
  const b = w.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:,?\s+(\d{4}))?\b/);
  if (a) {
    month = monthIdx(a[1]);
    day = Number(a[2]);
    year = a[3] ? Number(a[3]) : null;
  } else if (b) {
    month = monthIdx(b[2]);
    day = Number(b[1]);
    year = b[3] ? Number(b[3]) : null;
  } else return null;
  if (month < 0 || !day) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const make = (y: number) => `${y}-${pad(month + 1)}-${pad(day!)}`;
  if (year !== null) return isCalendarDate(make(year)) ? make(year) : null;
  const y0 = Number(today.slice(0, 4));
  for (const y of [y0, y0 + 1]) if (isCalendarDate(make(y)) && make(y) >= today) return make(y);
  return null;
}

/** Currency written in a phrase: "USD", "INR", "OTHER" (€, £, C$, …), or null if none. */
export function currencyIn(phrase: string): "USD" | "INR" | "OTHER" | null {
  const p = phrase.toLowerCase();
  if (/€|£|¥|\b(eur|euros?|gbp|pounds?|yen|cad|aud|chf|sgd)\b|\b(c|a|nz|s|hk)\$/.test(p)) return "OTHER";
  if (/₹|\brs\.?\s*\d|\binr\b|rupees?/.test(p)) return "INR";
  if (/\$|\busd\b|dollars?/.test(p)) return "USD";
  return null;
}

/** Whether `n` is one end of a range written in the text ("50-60", "50–60", "50 to 60", "50 or 60", "between 50 and 60"). */
export function inRange(text: string, n: number): boolean {
  const t = text
    .toLowerCase()
    .replace(/,(?=\d{3})/g, "")
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, " ") // ISO dates are not ranges
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, " "); // nor 12/15
  const ranges = [...t.matchAll(/(\d+(?:\.\d+)?)\s*(?:-|–|—|to|or)\s*\$?(\d+(?:\.\d+)?)/g), ...t.matchAll(/between\s+\$?(\d+(?:\.\d+)?)\s+and\s+\$?(\d+(?:\.\d+)?)/g)];
  return ranges.some((m) => Number(m[1]) === n || Number(m[2]) === n);
}

// ── Reading in code, independently of the model ─────────────────────────────

const PRODUCT_NOUN = String.raw`(?:scarves|scarfs|scarf|stoles?|dupattas?|wraps?|pieces|piece|pcs|units?|items?)`;

/** The quantity written next to a product word ("30 scarves", "thirty indigo stoles", "2 dozen pieces"); null if none or several. */
function quantityEvidence(text: string): { reading: { value: number; words: string } | null; ambiguous: boolean } {
  const tokens = text.toLowerCase().replace(/-/g, " ").split(/\s+/).map((w) => w.replace(/^[^a-z0-9$₹€£]+|[^a-z0-9]+$/g, "")).filter(Boolean);
  const noun = new RegExp(`^${PRODUCT_NOUN}$`);
  const found = new Map<number, string>();
  let measurement = false;
  let mentions = 0;
  tokens.forEach((tok, k) => {
    if (!noun.test(tok)) return;
    // The number closest before this product word, within three other words, not a price and not past another product word.
    for (let i = k - 1; i >= Math.max(0, k - 4); i--) {
      if (noun.test(tokens[i]) || /[$₹€£]/.test(tokens[i]) || /^(rs|usd|inr)$/.test(tokens[i])) break;
      // Number words run together ("two hundred and fifty"): take the whole run.
      const NUMWORD = /^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|and|a|dozen)$/;
      let from = i;
      while (from > 0 && NUMWORD.test(tokens[from]) && NUMWORD.test(tokens[from - 1]) && k - (from - 1) <= 7) from--;
      if (tokens[i] === "dozen" && from === i && i > 0) from = i - 1;
      const span = tokens.slice(from, k);
      const dozen = span.length >= 2 && span[1] === "dozen" ? [...numbersIn(span[0])].filter((n) => Number.isInteger(n) && n > 0) : [];
      const nums = dozen.length === 1 ? [dozen[0] * 12] : [...numbersIn(NUMWORD.test(tokens[i]) ? span.join(" ") : tokens[i])].filter((n) => Number.isInteger(n) && n > 0);
      if (nums.length) {
        const units = /^(?:mm|cm|m|(?:milli|centi)?metres?|(?:milli|centi)?meters?|inches?|in|ft|feet|foot|yards?|yd|kg|g|grams?|gsm|oz|ounces?|ml|litres?|liters?)$/;
        if (span.some((w) => units.test(w) || /\d(?:mm|cm|m|in|ft|kg|gsm|oz)$/.test(w)) || /^(?:size|length|width|weight)$/.test(tokens[from - 1] ?? "")) {
          measurement = true;
          break;
        }
        mentions++;
        found.set(Math.max(...nums), [...span, tok].join(" "));
        break;
      }
    }
  });
  return { reading: mentions === 1 ? { value: [...found.keys()][0], words: [...found.values()][0] } : null, ambiguous: mentions > 1 || (mentions === 0 && measurement) };
}

export function quantityInWords(text: string): { value: number; words: string } | null {
  return quantityEvidence(text).reading;
}

/** A budget written with its currency ("$250", "250 dollars", "USD 400", "₹22,000", "$15 each"); null if none or several. */
type BudgetReading = { amount: number; currency: "USD" | "INR"; basis: "total" | "per_piece"; words: string };

function budgetEvidence(text: string): { reading: BudgetReading | null; ambiguous: boolean } {
  const t = text.toLowerCase();
  const num = String.raw`(\d[\d,]*(?:\.\d+)?)\s*(k\b)?`;
  const patterns: [RegExp, "USD" | "INR"][] = [
    [new RegExp(String.raw`(?<![a-z])(?:us\s?)?\$\s?${num}`, "g"), "USD"],
    [new RegExp(String.raw`\busd\s?${num}`, "g"), "USD"],
    [new RegExp(String.raw`${num}\s?(?:usd|us dollars|dollars)\b`, "g"), "USD"],
    [new RegExp(String.raw`₹\s?${num}`, "g"), "INR"],
    [new RegExp(String.raw`\b(?:rs\.?|inr)\s?${num}`, "g"), "INR"],
    [new RegExp(String.raw`${num}\s?(?:inr|rupees?)\b`, "g"), "INR"],
  ];
  const found = new Map<string, { amount: number; currency: "USD" | "INR"; basis: "total" | "per_piece"; words: string }>();
  for (const [re, currency] of patterns) {
    for (const m of t.matchAll(re)) {
      const amount = Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1);
      if (!(amount > 0)) continue;
      const after = t.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 14);
      const basis = /^\s*(each|per piece|a piece|apiece|per scarf|a scarf)/.test(after) ? "per_piece" : "total";
      found.set(`${currency}:${amount}:${basis}`, { amount, currency, basis, words: m[0].trim() });
    }
  }
  return { reading: found.size === 1 ? [...found.values()][0] : null, ambiguous: found.size > 1 };
}

export function budgetInWords(text: string): BudgetReading | null {
  return budgetEvidence(text).reading;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const SMALL: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const at = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const addDays = (isoDay: string, n: number) => iso(new Date(Date.parse(`${isoDay}T00:00:00Z`) + n * 86_400_000));
const nextMonthIdx = (today: string, m: number) => (m >= Number(today.slice(5, 7)) - 1 ? Number(today.slice(0, 4)) : Number(today.slice(0, 4)) + 1);

/**
 * Relative dates resolved by fixed, published rules (never by the model's arithmetic).
 * The buyer always sees the rule and confirms; see docs/collective-consent.md.
 */
export function relativeDate(phrase: string, today: string): { date: string; rule: string } | null {
  const p = phrase.toLowerCase();
  const y = Number(today.slice(0, 4));
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  let m = p.match(/\b(?:in|within)\s+(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(day|week|month)s?\b/) ?? p.match(/\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(day|week|month)s?\s+from\s+(?:now|today)\b/);
  if (m) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : SMALL[m[1]];
    if (m[2] === "month") {
      const d = new Date(`${today}T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + n);
      return { date: iso(d), rule: `${n} month${n === 1 ? "" : "s"} from today` };
    }
    return { date: addDays(today, n * (m[2] === "week" ? 7 : 1)), rule: `${n} ${m[2]}${n === 1 ? "" : "s"} from today` };
  }
  if ((m = p.match(/\bnext\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/))) {
    const target = WEEKDAYS.indexOf(m[1]);
    const toMonday = ((8 - dow) % 7) || 7; // days to next week's Monday
    return { date: addDays(today, toMonday + ((target + 6) % 7)), rule: `“next ${m[1]}” = the ${m[1]} of next week` };
  }
  if ((m = p.match(/\b(?:this|by|on|before)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/))) {
    const target = WEEKDAYS.indexOf(m[1]);
    return { date: addDays(today, ((target - dow + 7) % 7) || 7), rule: `the coming ${m[1]}` };
  }
  if (/\bend of (?:the |this )?month\b/.test(p)) {
    return { date: iso(at(y, Number(today.slice(5, 7)), 0)), rule: "the last day of this month" };
  }
  if (/\bend of next month\b/.test(p)) return { date: iso(at(y, Number(today.slice(5, 7)) + 1, 0)), rule: "the last day of next month" };
  if ((m = p.match(new RegExp(String.raw`\b(early|beginning of|start of|mid|middle of|late|end of)\s+(${MONTH_NAMES.join("|")}|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b`)))) {
    const mi = MONTH_NAMES.findIndex((n) => n.startsWith(m![2].slice(0, 3)));
    const yr = nextMonthIdx(today, mi);
    const part = m[1];
    const day = /early|beginning|start/.test(part) ? 10 : /mid|middle/.test(part) ? 15 : part === "late" ? 25 : new Date(Date.UTC(yr, mi + 1, 0)).getUTCDate();
    return { date: iso(at(yr, mi, day)), rule: `“${part} ${MONTH_NAMES[mi]}” = ${MONTH_NAMES[mi][0].toUpperCase()}${MONTH_NAMES[mi].slice(1)} ${day}` };
  }
  const holiday = (name: string, month: number, day: number) => {
    const before = new RegExp(String.raw`\bbefore\s+(?:the\s+)?${name}`).test(p);
    const yr = iso(at(y, month, day)) > today ? y : y + 1;
    return { date: addDays(iso(at(yr, month, day)), before ? -1 : 0), rule: before ? `the day before ${name.replace(/\.*$/, "")}` : name.replace(/\.*$/, "") };
  };
  if (/christmas|xmas/.test(p)) return holiday("christmas", 11, 25);
  if (/new year/.test(p)) return holiday("new year", 0, 1);
  if (/valentine/.test(p)) return holiday("valentine", 1, 14);
  if ((m = p.match(new RegExp(String.raw`\b(?:by|before|in|for)\s+(${MONTH_NAMES.join("|")})\b`)))) {
    const mi = MONTH_NAMES.indexOf(m[1]);
    const yr = nextMonthIdx(today, mi);
    return { date: iso(at(yr, mi, 1)), rule: `“by ${m[1]}” = ${MONTH_NAMES[mi][0].toUpperCase()}${MONTH_NAMES[mi].slice(1)} 1` };
  }
  if (/\btomorrow\b/.test(p)) return { date: addDays(today, 1), rule: "tomorrow" };
  return null;
}

/** Explicit dates keep their deadline operator; "before D" means no later than the preceding day. */
function datePhrase(words: string, today: string): { date: string; rule: string | null } | null {
  const d = explicitDate(words, today);
  if (!d) return relativeDate(words, today);
  if (/\b(?:not before|no earlier than|after|between)\b/.test(words.toLowerCase())) return null;
  return /\bbefore\b/.test(words.toLowerCase())
    ? { date: addDays(d, -1), rule: `before ${d} = no later than the previous day` }
    : { date: d, rule: null };
}

type DateEvidence = { reading: { date: string; words: string; rule: string | null } | null; ambiguous: boolean; unsupported: boolean; unavailable: boolean };

/** Dates of events, dispatch and payment are not automatically delivery deadlines. */
function deliveryEvidence(text: string, today: string): DateEvidence {
  const t = text.toLowerCase();
  if (/\b(?:delivery(?: date)?|deadline)\b[^.!?\n]{0,45}\b(?:not (?:decided|set|known|confirmed)|unknown|undecided|tbd|to be (?:decided|confirmed))\b/.test(t)) {
    return { reading: null, ambiguous: false, unsupported: true, unavailable: true };
  }
  const explicit = new Map<string, { date: string; words: string; rule: string | null }>();
  let candidates = 0;
  const monthRe = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?`;
  for (const m of t.matchAll(new RegExp(String.raw`\b\d{4}-\d{2}-\d{2}\b|\b${monthRe}\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?${monthRe}(?:,?\s+\d{4})?\b`, "g"))) {
    candidates++;
    const prefix = t.slice(0, m.index).split(/[.!?;\n]/).pop() ?? "";
    if (/\b(?:not before|no earlier than|after|from|between)\s+(?:the\s+)?$/.test(prefix)) continue;
    const roles = [...prefix.matchAll(/\b(deliver(?:y|ed)?|arriv(?:e|al)|deadline|due|dispatch(?:ed)?|ship(?:ping)?|event|birthday|wedding|invoice|deposit)\b/g)];
    const lastRole = roles.at(-1);
    const role = lastRole?.[1];
    if (role && /^(?:dispatch|ship|invoice|deposit)/.test(role)) continue;
    if (role && /^(?:event|birthday|wedding)/.test(role) && !/\b(?:by|before|deliver(?:y|ed)?|deadline)\b/.test(prefix.slice(lastRole!.index! + role.length))) continue;
    if (!/\b(?:by|before|deliver(?:y|ed)?|arriv(?:e|al)|need(?:ed)?|due|deadline)\b/.test(prefix)) continue;
    const before = /\bbefore\s+(?:the\s+)?$/.test(prefix);
    const words = `${before ? "before " : ""}${m[0]}`;
    const d = datePhrase(words, today);
    if (d) explicit.set(d.date, { ...d, words });
  }
  if (explicit.size === 1) return { reading: [...explicit.values()][0], ambiguous: false, unsupported: false, unavailable: false };
  if (candidates) return { reading: null, ambiguous: explicit.size > 1, unsupported: explicit.size === 0, unavailable: false };
  const r = relativeDate(t, today);
  return { reading: r ? { ...r, words: text } : null, ambiguous: false, unsupported: false, unavailable: false };
}

/** A single delivery-context date, otherwise left for confirmation. */
export function dateInWords(text: string, today: string): { date: string; words: string; rule: string | null } | null {
  return deliveryEvidence(text, today).reading;
}

const MONEY_WORDS = /\b(budget|price|cost|costs|pay|paying|each|per|apiece|total|max|maximum|around|about)\b/;

const contains = (text: string, words: string | null) => !!words && words.trim().length > 0 && text.toLowerCase().includes(words.trim().toLowerCase());
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const enDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * Deterministic: the model's reading → an interpretation the buyer reviews. `earliest`
 * is the first delivery date that can be asked for (dates before it are not accepted).
 */
export function interpret(text: string, raw: unknown, ctx: { today: string; earliest: string; inrPerUsd: number; product: string }): Interpretation {
  const parsed = HeardSchema.safeParse(raw);
  const questions: string[] = [];
  if (!parsed.success) {
    return {
      quantity: { value: null, status: "missing", words: null, note: null },
      deadline: { value: null, status: "missing", words: null, note: null },
      budgetUsdCents: { value: null, status: "missing", words: null, note: null },
      details: { value: null, status: "missing", words: null, note: null },
      product: { matches: "unclear", asked: null, note: null },
      questions: ["We couldn't read the request automatically. Please fill in the details."],
    };
  }
  const h = parsed.data;
  const numbers = numbersIn(text);

  // Quantity.
  let quantity: Field<number>;
  const q = h.quantity;
  const qEvidence = quantityEvidence(text);
  const codeQ = qEvidence.reading;
  if ((q === null || !Number.isInteger(q) || q < 1) && codeQ && codeQ.value <= MAX_QUANTITY) {
    // The model found none; the buyer's own words have one next to the product.
    const range = inRange(text, codeQ.value);
    quantity = { value: codeQ.value, status: range ? "assumed" : "stated", words: codeQ.words, note: range ? `You gave a range; we used ${codeQ.value}. Please choose the number of pieces.` : null };
    if (range) questions.push("How many pieces exactly?");
  } else if (q === null || !Number.isInteger(q) || q < 1 || q > MAX_QUANTITY) {
    quantity = { value: null, status: "missing", words: null, note: q === null ? null : `Quantity must be a whole number from 1 to ${MAX_QUANTITY.toLocaleString("en-US")}.` };
    questions.push("How many pieces do you need?");
  } else {
    // Field-specific evidence: the model's own quote for the QUANTITY must be in the text and
    // contain this number, must not be a money phrase, and the number must not be a range end.
    const words = contains(text, h.quantityWords) ? h.quantityWords!.trim() : null;
    const quoted = !!words && numbersIn(words).has(q) && currencyIn(words) === null && !MONEY_WORDS.test(words.toLowerCase());
    const range = inRange(text, q);
    const note = range
      ? `You gave a range; we used ${q}. Please choose the number of pieces.`
      : quoted
        ? null
        : numbers.has(q)
          ? `We read ${q} as the number of pieces. Please check it.`
          : "This number isn't in your words. Please check it.";
    // Code's own reading must agree: a disagreement is shown, never silently resolved.
    const confirmedByCode = codeQ?.value === q;
    const conflict = codeQ && codeQ.value !== q ? `Your words also say ${codeQ.value} (“${codeQ.words}”). Please check the number of pieces.` : null;
    quantity = {
      value: q,
      status: (quoted || confirmedByCode) && !range && !conflict && !qEvidence.ambiguous ? "stated" : "assumed",
      words: words ?? (confirmedByCode ? codeQ!.words : null),
      note: qEvidence.ambiguous ? "Your message gives multiple quantities or a measurement. Please confirm how many pieces you need." : conflict ?? (confirmedByCode && !range ? null : note),
    };
    if (range) questions.push("How many pieces exactly?");
  }

  // Delivery date: explicit dates and relative phrases are resolved in CODE; the model only points at the words.
  let deadline: Field<string>;
  const aiWords = contains(text, h.deliverByWords) ? h.deliverByWords!.trim() : null;
  const aiDate = h.deliverBy !== null && isCalendarDate(h.deliverBy) ? h.deliverBy : null;
  const fromAiWords = aiWords ? datePhrase(aiWords, ctx.today) : null;
  const dEvidence = deliveryEvidence(text, ctx.today);
  const fromText = dEvidence.reading;
  let chosen: { value: string; words: string | null; rule: string | null; explicit: boolean } | null = null;
  if (fromText) chosen = { value: fromText.date, words: fromText.words, rule: fromText.rule, explicit: fromText.rule === null };
  else if (fromAiWords && !dEvidence.unavailable) chosen = { value: fromAiWords.date, words: aiWords, rule: fromAiWords.rule, explicit: fromAiWords.rule === null };
  else if (aiDate && !dEvidence.unavailable) chosen = { value: aiDate, words: aiWords, rule: null, explicit: false };
  const disagree = chosen && aiDate && aiDate !== chosen.value;
  if (!chosen) {
    deadline = { value: null, status: "missing", words: null, note: null };
    questions.push("By what date must the pieces be delivered?");
  } else if (chosen.value < ctx.earliest) {
    deadline = { value: null, status: "missing", words: chosen.words, note: `That date has passed or is too soon. The earliest date you can ask for is ${enDate(ctx.earliest)}.` };
    questions.push("By what date must the pieces be delivered?");
  } else if (chosen.explicit && !disagree && !dEvidence.ambiguous && !dEvidence.unsupported) {
    deadline = { value: chosen.value, status: "stated", words: chosen.words, note: null };
  } else {
    const how = chosen.rule ? `We read ${chosen.words ? `“${chosen.words}”` : "your date"} as ${enDate(chosen.value)} (${chosen.rule}).` : chosen.words ? `We read “${chosen.words}” as ${enDate(chosen.value)}.` : `We assumed ${enDate(chosen.value)}.`;
    deadline = { value: chosen.value, status: "assumed", words: chosen.words, note: `${how} ${dEvidence.ambiguous ? "Your message gives multiple possible delivery dates. Please choose one." : dEvidence.unsupported ? "Is this the delivery deadline, rather than an event or shipping date? Please confirm." : "Please confirm."}` };
  }

  // Budget (USD cents; INR converted at the collective's recorded rate).
  let budgetUsdCents: Field<number>;
  // Code CHECKS the model's budget against the words but never supplies one: a budget is optional,
  // and an amount in the text may be an instruction ("set the price to $1"), not the buyer's budget.
  const bEvidence = budgetEvidence(text);
  const codeB = bEvidence.reading;
  const b = h.budget;
  const bWords = contains(text, h.budgetWords) ? h.budgetWords!.trim() : null;
  const quotedCurrency = bWords ? currencyIn(bWords) : null;
  // Any non-dollar, non-rupee currency in the budget's own words — or anywhere in the text when the
  // model gave no quote — means the amount can't be read as dollars or rupees.
  const foreign = quotedCurrency === "OTHER" || (!bWords && currencyIn(text) === "OTHER") || (b !== null && b.currency !== "OTHER" && quotedCurrency !== null && quotedCurrency !== b.currency && currencyIn(text) === "OTHER");
  if (b === null) budgetUsdCents = { value: null, status: "missing", words: null, note: null };
  else if (b.currency === "OTHER" || foreign || !(b.amount > 0) || !Number.isFinite(b.amount)) {
    budgetUsdCents = { value: null, status: "missing", words: contains(text, h.budgetWords) ? h.budgetWords : null, note: "Please give the budget in US dollars." };
    questions.push("What is your budget in US dollars? (Optional)");
  } else {
    const perPiece = b.basis === "per_piece";
    if (perPiece && quantity.value === null) {
      budgetUsdCents = { value: null, status: "missing", words: contains(text, h.budgetWords) ? h.budgetWords : null, note: "A per-piece budget needs the quantity. Please give the total budget." };
    } else {
      const usdAmount = b.currency === "USD" ? b.amount : b.amount / ctx.inrPerUsd;
      const cents = Math.round(usdAmount * 100 * (perPiece ? quantity.value! : 1));
      // Field-specific evidence: the budget's own quote contains this amount AND names this currency.
      const hasAmount = !!bWords && numbersIn(bWords).has(b.amount);
      const currencyMatches = quotedCurrency === b.currency;
      const range = inRange(text, b.amount);
      const codeDisagrees = codeB && (codeB.amount !== b.amount || codeB.currency !== b.currency || codeB.basis !== b.basis) ? `Your words say ${codeB.words}${codeB.basis === "per_piece" ? " per piece" : " for the order"}. Please confirm the total budget.` : null;
      // Text that tries to instruct (the model or us) never yields a budget labelled as the buyer's own words.
      const instructed = /\b(?:ignore|disregard)\b[^.]{0,40}\binstructions?\b|\bsystem prompt\b|\bset (?:the )?(?:price|budget|total|amount)\b/i.test(text);
      const grounded = hasAmount && currencyMatches && !range && !codeDisagrees && !instructed && !bEvidence.ambiguous;
      const notes = [
        bEvidence.ambiguous ? "Your message gives more than one amount. Please confirm the total budget." : null,
        instructed ? "Your message contains instructions; please confirm the budget yourself." : null,
        codeDisagrees,
        !hasAmount ? (numbers.has(b.amount) ? `We read ${b.amount} as the budget. Please check it.` : "This amount isn't in your words. Please check it.") : null,
        hasAmount && !currencyMatches ? (quotedCurrency === null ? `Is that ${b.currency === "USD" ? "in US dollars" : "in rupees"}? Please check.` : "The currency doesn't match your words. Please check it.") : null,
        range ? "You gave a range. Please give one budget." : null,
        b.currency === "INR" ? `Converted from ₹${b.amount.toLocaleString("en-IN")} at ₹${ctx.inrPerUsd} to the dollar.` : null,
        perPiece ? `${usd(Math.round(usdAmount * 100))} a piece × ${quantity.value} pieces.` : null,
      ].filter(Boolean);
      budgetUsdCents = {
        value: cents > 0 ? cents : null,
        status: cents <= 0 ? "missing" : grounded && b.currency === "USD" && !perPiece ? "stated" : "assumed",
        words: bWords,
        note: notes.length ? notes.join(" ") : null,
      };
    }
  }

  // Description: the buyer's own requirements, shortened. Always shown for review.
  const det = h.details?.trim().slice(0, 300) || null;
  const details: Field<string> = det ? { value: det, status: "assumed", words: null, note: "Our summary of your requirements. Edit it to say exactly what you need." } : { value: null, status: "missing", words: null, note: null };

  const product = {
    matches: h.matchesProduct,
    asked: h.item?.trim().slice(0, 120) || null,
    note: h.matchesProduct === "no" ? `This collective makes only ${plural(ctx.product)}.` : h.matchesProduct === "unclear" ? `This collective makes ${plural(ctx.product)}. Is that what you need?` : null,
  };
  if (h.matchesProduct !== "yes") questions.push(product.note!);
  for (const u of h.unclear.slice(0, 3)) if (u.trim()) questions.push(u.trim().slice(0, 200));

  return { quantity, deadline, budgetUsdCents, details, product, questions: [...new Set(questions)] };
}

/** Which fields the buyer changed from the proposal (kept with the order for evaluation). */
export function editedFields(proposed: Interpretation | null, confirmed: { quantity: number; deadline: string; budgetUsdCents: number | null; details: string | null }): string[] {
  if (!proposed) return [];
  const out: string[] = [];
  if (proposed.quantity.value !== confirmed.quantity) out.push("quantity");
  if (proposed.deadline.value !== confirmed.deadline) out.push("deadline");
  if (proposed.budgetUsdCents.value !== confirmed.budgetUsdCents) out.push("budget");
  if ((proposed.details.value ?? null) !== (confirmed.details ?? null)) out.push("details");
  return out;
}

const FieldSchema = <T extends z.ZodTypeAny>(v: T) =>
  z.object({ value: v.nullable(), status: z.enum(["stated", "assumed", "missing"]), words: z.string().max(300).nullable(), note: z.string().max(400).nullable() });

/** Shape check for an interpretation returned by the buyer's browser (kept for the record only; never trusted for planning). */
export const InterpretationSchema = z.object({
  quantity: FieldSchema(z.number()),
  deadline: FieldSchema(z.string().max(10)),
  budgetUsdCents: FieldSchema(z.number()),
  details: FieldSchema(z.string().max(300)),
  product: z.object({ matches: z.enum(["yes", "no", "unclear"]), asked: z.string().max(120).nullable(), note: z.string().max(300).nullable() }),
  questions: z.array(z.string().max(300)).max(10),
});
