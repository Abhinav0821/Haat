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
  if (q === null || !Number.isInteger(q) || q < 1 || q > MAX_QUANTITY) {
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
    quantity = { value: q, status: quoted && !range ? "stated" : "assumed", words, note };
    if (range) questions.push("How many pieces exactly?");
  }

  // Delivery date.
  let deadline: Field<string>;
  const d = h.deliverBy;
  if (d === null || !isCalendarDate(d)) {
    deadline = { value: null, status: "missing", words: null, note: null };
    questions.push("By what date must the pieces be delivered?");
  } else if (d < ctx.earliest) {
    deadline = { value: null, status: "missing", words: contains(text, h.deliverByWords) ? h.deliverByWords : null, note: `That date has passed or is too soon. The earliest date you can ask for is ${enDate(ctx.earliest)}.` };
    questions.push("By what date must the pieces be delivered?");
  } else {
    const words = contains(text, h.deliverByWords) ? h.deliverByWords : null;
    const own = words ? explicitDate(words, ctx.today) : null;
    deadline =
      own === d
        ? { value: d, status: "stated", words, note: null }
        : { value: d, status: "assumed", words, note: words ? `We read “${words}” as ${enDate(d)}. Please confirm.` : `We assumed ${enDate(d)}. Please confirm.` };
  }

  // Budget (USD cents; INR converted at the collective's recorded rate).
  let budgetUsdCents: Field<number>;
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
      const grounded = hasAmount && currencyMatches && !range;
      const notes = [
        !hasAmount ? (numbers.has(b.amount) ? `We read ${b.amount} as the budget. Please check it.` : "This amount isn't in your words. Please check it.") : null,
        hasAmount && !currencyMatches ? (quotedCurrency === null ? `Is that ${b.currency === "USD" ? "in US dollars" : "in rupees"}? Please check.` : "The currency doesn't match your words. Please check it.") : null,
        range ? "You gave a range. Please give one budget." : null,
        b.currency === "INR" ? `Converted from ₹${b.amount.toLocaleString("en-IN")} at ₹${ctx.inrPerUsd} to the dollar.` : null,
        perPiece ? `${usd(Math.round(usdAmount * 100))} a piece × ${quantity.value} pieces.` : null,
      ].filter(Boolean);
      budgetUsdCents = {
        value: cents > 0 ? cents : null,
        status: cents <= 0 ? "missing" : grounded && b.currency === "USD" && !perPiece ? "stated" : "assumed",
        words: contains(text, h.budgetWords) ? h.budgetWords : null,
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
