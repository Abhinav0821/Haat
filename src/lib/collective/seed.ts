import { eq } from "drizzle-orm";
import { schema, type DB } from "@/db";
import { MemberFactsSchema, SettingsSchema, type CollectiveSettings, type StoredMemberFacts } from "./facts";
import { linkHash, newLinkToken } from "./service";

/**
 * A demo collective: three block printers in one cluster who share a finishing
 * (wash, iron, inspect) table. Their facts are entered as the coordinator's
 * estimates; each maker confirms her own on her personal link.
 */

export const DEMO_COLLECTIVE_SLUG = "bagru-printers";

type SeedMember = { name: string; nameHi: string; facts: Omit<StoredMemberFacts, "prov"> };

export function demoSettings(at: string): CollectiveSettings {
  return SettingsSchema.parse({
    product: { en: "hand block-printed cotton scarf", hi: "हाथ से छपा सूती दुपट्टा" },
    finishingPerWeekday: [0, 8, 8, 8, 8, 8, 4],
    finishingOffDates: [],
    lagDays: 1,
    packDays: 1,
    transitDays: 7,
    costs: { finishingInrPerPiece: 40, packagingInrPerPiece: 30, collectionInrPerPiece: 15, chargeInrPerPiece: 45, shippingInrPerOrder: 4200 },
    fee: { percent: 4.4, fixedUsdCents: 30 },
    inrPerUsd: 88,
    horizonDays: 120,
    // Maker-confirmed availability is re-asked after this many days. 60 keeps facts confirmed
    // in early November current through the judging window (Dec 1–15); a real collective sets its own.
    staleAfterDays: 60,
    prov: { source: "coordinator_entered", by: "coordinator", at },
  });
}

export const DEMO_MEMBERS: SeedMember[] = [
  {
    name: "Meera",
    nameHi: "मीरा",
    facts: { makesProduct: true, piecesPerWeekday: [0, 3, 3, 3, 3, 3, 2], offDates: [], materialsDays: 0, commitments: [{ ref: "shop orders", pieces: 6, due: null }], askInr: 420, floorInr: 360, maxPieces: null },
  },
  {
    name: "Sunita",
    nameHi: "सुनीता",
    facts: { makesProduct: true, piecesPerWeekday: [0, 2, 2, 2, 2, 2, 0], offDates: [], materialsDays: 3, commitments: [], askInr: 380, floorInr: 340, maxPieces: 20 },
  },
  {
    name: "Rukhsana",
    nameHi: "रुख़साना",
    facts: { makesProduct: true, piecesPerWeekday: [0, 4, 4, 4, 0, 4, 4], offDates: [], materialsDays: 2, commitments: [], askInr: 450, floorInr: 400, maxPieces: null },
  },
];

export async function seedCollective(d: DB, opts: { slug?: string; name?: string; at?: Date; members?: SeedMember[]; settings?: CollectiveSettings } = {}) {
  const at = (opts.at ?? new Date()).toISOString();
  const slug = opts.slug ?? DEMO_COLLECTIVE_SLUG;
  const [existing] = await d.select().from(schema.collectives).where(eq(schema.collectives.slug, slug));
  if (existing) throw new Error(`collective ${slug} already exists`);
  const [c] = await d
    .insert(schema.collectives)
    .values({ slug, name: opts.name ?? "Bagru Printers Collective", coordinatorName: "Kavita", settings: (opts.settings ?? demoSettings(at)) as unknown as Record<string, unknown> })
    .returning();
  const members: { id: string; name: string; token: string }[] = [];
  for (const m of opts.members ?? DEMO_MEMBERS) {
    const token = newLinkToken();
    const facts = MemberFactsSchema.parse({ ...m.facts, prov: { source: "coordinator_entered", by: "coordinator", at } });
    const [row] = await d
      .insert(schema.members)
      .values({ collectiveId: c.id, name: m.name, nameHi: m.nameHi, linkHash: linkHash(token), facts: facts as unknown as Record<string, unknown> })
      .returning();
    members.push({ id: row.id, name: row.name, token });
  }
  return { collective: c, members };
}

/** A new personal link for a maker (shown once; the old link stops working). */
export async function newMemberLink(d: DB, memberId: string) {
  const token = newLinkToken();
  const [m] = await d.update(schema.members).set({ linkHash: linkHash(token) }).where(eq(schema.members.id, memberId)).returning({ id: schema.members.id });
  if (!m) throw new Error("maker not found");
  return token;
}
