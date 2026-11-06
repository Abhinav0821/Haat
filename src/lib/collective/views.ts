import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { dayDate, type Plan } from "@/lib/planner/model";
import { summarise } from "./explain";
import { materialsReadyOn, MemberFactsSchema } from "./facts";
import { CollectiveError, currentPlan, evaluateOrder, memberByLink, partStatuses, settingsOf, type OrderSpec } from "./service";
import { buyerLinesEn, hasHindiRequirements, partLinesEn, partReadbackHi, type BuyerTerms, type PartTerms, type PlanTerms } from "./terms";

/**
 * Who sees what (docs/planner-model.md §4):
 *  - internal (coordinator): facts with provenance, the plan, certificates' verdicts;
 *  - buyer / agent: quantity, dates, total, aggregate explanation — no maker's ask,
 *    minimum, availability, promises or name;
 *  - maker: only her own parts and her own facts.
 */

const PROV_EN: Record<string, string> = { maker_confirmed: "confirmed by her", coordinator_entered: "entered by the coordinator (estimate)" };

export async function internalView(orderId: string, now = new Date()) {
  const d = await db();
  const plan = await currentPlan(d, orderId, now);
  const { order, collective, facts, request, evaluation, problems } = await evaluateOrder(orderId, now, plan?.id);
  const spec = order.spec as OrderSpec;
  const members = await d.select().from(schema.members).where(eq(schema.members.collectiveId, collective.id)).orderBy(asc(schema.members.createdAt), asc(schema.members.id));
  const history = await d
    .select({ id: schema.collectivePlans.id, version: schema.collectivePlans.version, choice: schema.collectivePlans.choice, status: schema.collectivePlans.status, createdAt: schema.collectivePlans.createdAt })
    .from(schema.collectivePlans)
    .where(eq(schema.collectivePlans.orderId, orderId))
    .orderBy(desc(schema.collectivePlans.version));
  const checked = evaluation.kind !== "unresolved" && problems.length === 0;
  const summary = summarise(evaluation, facts, spec, "internal");

  let current = null;
  if (plan) {
    const p = plan.plan as unknown as Plan;
    const start = (plan.facts as { startDate: string }).startDate;
    const terms = plan.terms as unknown as PlanTerms;
    const parts = await partStatuses(d, plan);
    const days = [...new Set(p.production.map((x) => x.day))].sort((a, b) => a - b);
    current = {
      id: plan.id,
      version: plan.version,
      choice: plan.choice,
      status: plan.status,
      statusNote: plan.statusNote,
      certified: plan.certified === 1,
      termsHash: plan.termsHash,
      holdUntil: plan.holdUntil?.toISOString() ?? null,
      buyerLines: buyerLinesEn(terms.buyer),
      parts,
      schedule: {
        dates: days.map((t) => dayDate(start, t)),
        rows: parts.map((m) => ({ name: m.name, pieces: days.map((t) => p.production.filter((x) => x.makerId === m.memberId && x.day === t).reduce((s, x) => s + x.pieces, 0)) })),
        finishing: p.finishing.map((f) => ({ date: dayDate(start, f.day), pieces: f.pieces })),
      },
      money: p.money,
    };
  }

  return {
    id: order.id,
    status: order.status,
    buyerName: order.buyerName,
    buyerText: order.buyerText,
    spec,
    collective: { name: collective.name, product: settingsOf(collective).product },
    excluded: members.filter((m) => order.excludedMemberIds.includes(m.id)).map((m) => m.name),
    makers: members.map((m) => {
      const f = MemberFactsSchema.parse(m.facts);
      return {
        id: m.id,
        name: m.name,
        piecesPerWeekday: f.piecesPerWeekday,
        materialsDays: f.materialsDays,
        materialsReadyDate: materialsReadyOn(f),
        commitments: f.commitments.reduce((s, c) => s + c.pieces, 0),
        askInr: f.askInr,
        maxPieces: f.maxPieces,
        source: PROV_EN[f.prov.source],
        confirmed: f.prov.source === "maker_confirmed",
        at: f.prov.at,
      };
    }),
    evaluation: { kind: evaluation.kind, checked, problems: problems.slice(0, 3), ...summary, startDate: facts.startDate, deliveryDay: request.deliveryDay },
    plan: current,
    history: history.map((h) => ({ ...h, createdAt: h.createdAt.toISOString() })),
  };
}

export async function buyerView(orderId: string, now = new Date()) {
  const d = await db();
  const [order] = await d.select().from(schema.collectiveOrders).where(eq(schema.collectiveOrders.id, orderId));
  if (!order) throw new CollectiveError("order not found", 404);
  const [c] = await d.select().from(schema.collectives).where(eq(schema.collectives.id, order.collectiveId));
  const plan = await currentPlan(d, orderId, now);
  const spec = order.spec as OrderSpec;
  let offer = null;
  if (plan && plan.status !== "needs_replan" && plan.status !== "maker_declined") {
    const terms = plan.terms as unknown as PlanTerms;
    const parts = await d.select({ id: schema.memberParts.id, status: schema.memberParts.status }).from(schema.memberParts).where(inArray(schema.memberParts.id, terms.parts.map((p) => p.partId)));
    offer = {
      id: plan.id,
      version: plan.version,
      status: plan.status,
      termsHash: plan.termsHash,
      lines: buyerLinesEn(terms.buyer),
      totalUsdCents: (terms.buyer as BuyerTerms).totalUsdCents,
      makersConfirmed: parts.filter((p) => p.status === "accepted").length,
      makers: terms.parts.length,
      holdUntil: plan.holdUntil?.toISOString() ?? null,
    };
  }
  return {
    id: order.id,
    collective: c.name,
    product: settingsOf(c).product.en,
    request: { quantity: spec.quantity, deadline: spec.deadline, budgetUsdCents: spec.budgetUsdCents, details: spec.details },
    status: order.status,
    revising: !!plan && (plan.status === "needs_replan" || plan.status === "maker_declined"),
    offer,
  };
}

export async function makerView(token: string, now = new Date()) {
  const member = await memberByLink(token);
  const d = await db();
  const [c] = await d.select().from(schema.collectives).where(eq(schema.collectives.id, member.collectiveId));
  const parts = await d.select().from(schema.memberParts).where(eq(schema.memberParts.memberId, member.id)).orderBy(desc(schema.memberParts.createdAt));
  const orderIds = [...new Set(parts.map((p) => p.orderId))];
  const live = new Map<string, { status: string; partIds: Set<string> }>();
  for (const id of orderIds) {
    const plan = await currentPlan(d, id, now);
    if (plan) live.set(id, { status: plan.status, partIds: new Set((plan.terms as unknown as PlanTerms).parts.map((p) => p.partId)) });
  }
  // Her latest version per order (a reused part is the latest: new versions exist only when her terms changed).
  const latest = orderIds.map((id) => parts.filter((p) => p.orderId === id).sort((a, b) => b.version - a.version)[0]);
  const f = MemberFactsSchema.parse(member.facts);
  return {
    name: member.name,
    nameHi: member.nameHi,
    collective: c.name,
    product: settingsOf(c).product,
    facts: { ...f, materialsReadyDate: materialsReadyOn(f), prov: { source: f.prov.source, at: f.prov.at } },
    parts: latest
      .filter((p) => p.status !== "superseded")
      .map((p) => {
        const t = p.terms as unknown as PartTerms;
        const plan = live.get(p.orderId);
        return {
          id: p.id,
          orderRef: t.orderRef,
          version: p.version,
          status: p.status,
          inCurrentPlan: !!plan?.partIds.has(p.id),
          orderStatus: plan?.status ?? null,
          termsHash: p.termsHash,
          requirementsReady: hasHindiRequirements(t),
          lines: partLinesEn(t),
          readbackHi: partReadbackHi(t),
          pieces: t.pieces,
          payInr: t.payInr,
          schedule: t.schedule,
          respondedAt: p.respondedAt?.toISOString() ?? null,
        };
      }),
    /** Orders where her part is no longer needed after a re-plan. */
    removed: latest.filter((p) => p.status === "superseded").map((p) => ({ orderRef: (p.terms as unknown as PartTerms).orderRef })),
  };
}

export async function listOrders(collectiveId: string) {
  const d = await db();
  const rows = await d
    .select({ id: schema.collectiveOrders.id, status: schema.collectiveOrders.status, buyerName: schema.collectiveOrders.buyerName, spec: schema.collectiveOrders.spec, createdAt: schema.collectiveOrders.createdAt })
    .from(schema.collectiveOrders)
    .where(and(eq(schema.collectiveOrders.collectiveId, collectiveId)))
    .orderBy(desc(schema.collectiveOrders.createdAt))
    .limit(50);
  return rows.map((r) => ({ ...r, spec: r.spec as OrderSpec, createdAt: r.createdAt.toISOString() }));
}
