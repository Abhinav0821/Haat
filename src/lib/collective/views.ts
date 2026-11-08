import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { dayDate, type Plan } from "@/lib/planner/model";
import { reconcileCollectiveIfStale } from "./checkout";
import { summarise } from "./explain";
import { aloneVsTogether, BUYER_SENTENCE } from "./compare";
import { shareSummaries } from "./payouts";
import { materialsReadyOn, MemberFactsSchema } from "./facts";
import { acceptedParts, CollectiveError, currentPlan, evaluateOrder, memberByLink, partStatuses, settingsOf, termsCtx, type OrderSpec } from "./service";
import { keepAgreedOption } from "./replan";
import { decidingQuestion } from "@/lib/planner/question";
import { checkQuestion } from "@/lib/planner/check";
import { questionWords } from "./explain";
import { buyerLinesEn, hasHindiRequirements, partLinesEn, partReadbackHi, type BuyerTerms, type PartTerms, type PlanTerms } from "./terms";

/**
 * Who sees what (docs/planner-model.md §4):
 *  - internal (coordinator): facts with provenance, the plan, certificates' verdicts;
 *  - buyer / agent: quantity, dates, total, aggregate explanation — no maker's ask,
 *    minimum, availability, promises or name;
 *  - maker: only her own parts and her own facts.
 */

const PROV_EN: Record<string, string> = { maker_confirmed: "confirmed by her", coordinator_entered: "entered by the coordinator (estimate)" };

/** The PayPal record behind a paying/paid plan: PayPal's own capture id, fee and net, never estimates. */
export async function paymentOf(d: Awaited<ReturnType<typeof db>>, paymentRef: string | null) {
  if (!paymentRef) return null;
  const [o] = await d.select().from(schema.orders).where(eq(schema.orders.id, paymentRef));
  if (!o) return null;
  // PayPal's own notifications about this payment, as delivered to our webhook (not the browser return).
  const ids = [o.paypalOrderId, o.paypalCaptureId].filter((x): x is string => !!x);
  const hooks = ids.length
    ? await d
        .select({ type: schema.webhookEvents.type, receivedAt: schema.webhookEvents.receivedAt, processedAt: schema.webhookEvents.processedAt })
        .from(schema.webhookEvents)
        .where(
          or(
            inArray(sql<string>`${schema.webhookEvents.payload}->'resource'->>'id'`, ids),
            eq(sql<string>`${schema.webhookEvents.payload}->'resource'->'supplementary_data'->'related_ids'->>'order_id'`, o.paypalOrderId),
          ),
        )
        .orderBy(asc(schema.webhookEvents.receivedAt))
    : [];
  return {
    webhooks: hooks.map((h) => ({ type: h.type, receivedAt: h.receivedAt.toISOString(), processed: !!h.processedAt })),
    paypalOrderId: o.paypalOrderId,
    captureId: o.paypalCaptureId,
    status: o.status,
    amountCents: o.amountCents,
    feeCents: o.feeCents,
    netCents: o.netCents,
    refundedCents: o.refundedCents,
    capturedAt: o.capturedAt?.toISOString() ?? null,
  };
}

export async function internalView(orderId: string, now = new Date()) {
  const d = await db();
  const plan = await reconcileCollectiveIfStale(await currentPlan(d, orderId, now), { now });
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
  const comparison = aloneVsTogether(facts, request, now, { evaluation, problems });

  // M1-Q1: when one unknown materials date is all that stands between "unresolved" and an answer.
  let question = null;
  const q = decidingQuestion(facts, request, now, evaluation);
  if (q) {
    const qProblems = checkQuestion(facts, request, q, now);
    question = { ...questionWords(q, facts, request), checked: qProblems.length === 0, problems: qProblems.slice(0, 3) };
  }

  // §D: a plan that keeps the agreed parts, after a maker said no or the facts changed.
  let keep = null;
  if (plan && (plan.status === "maker_declined" || plan.status === "needs_replan") && evaluation.kind === "feasible" && problems.length === 0) {
    const accepted = await acceptedParts(d, plan);
    if (accepted.length) {
      const r = keepAgreedOption(facts, request, now, accepted, termsCtx(collective, order.id, spec), evaluation.plan);
      keep = r.option
        ? { ...r.option, plan: undefined, makersInr: r.option.plan.money.makersInr }
        : { none: true as const, acceptedCount: accepted.length, search: r.search, failed: r.failed };
    }
  }

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
      payment: await paymentOf(d, plan.paymentRef),
      shares: (await shareSummaries(d, { planId: plan.id })).map((s) => ({ ...s, name: parts.find((x) => x.memberId === s.memberId)?.name ?? "?" })),
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
    /** Coordinator only: each maker's standalone answer. Never sent to buyers or agents. */
    comparison,
    question,
    keep,
    intake: order.intake ?? null,
    channel: order.channel,
    plan: current,
    history: history.map((h) => ({ ...h, createdAt: h.createdAt.toISOString() })),
  };
}

export async function buyerView(orderId: string, now = new Date()) {
  const d = await db();
  const [order] = await d.select().from(schema.collectiveOrders).where(eq(schema.collectiveOrders.id, orderId));
  if (!order) throw new CollectiveError("order not found", 404);
  const [c] = await d.select().from(schema.collectives).where(eq(schema.collectives.id, order.collectiveId));
  const plan = await reconcileCollectiveIfStale(await currentPlan(d, orderId, now), { now });
  const spec = order.spec as OrderSpec;
  // Today's checked answer for THIS request, in aggregate words only (no maker names, capacities or prices).
  const open = !plan || plan.status === "needs_replan" || plan.status === "maker_declined" || plan.choice === "primary" || plan.choice === "keep_agreed";
  let firstCheck: { kind: string; headline: string; reasons: string[] } | null = null;
  let together: string | null = null;
  if (open && (!plan || !["paying", "paid"].includes(plan.status))) {
    const r = await evaluateOrder(orderId, now, plan?.id, false);
    const checked = r.evaluation.kind === "unresolved" || r.problems.length === 0;
    if (checked) {
      const words = summarise(r.evaluation, r.facts, spec, "buyer");
      firstCheck = { kind: r.evaluation.kind, headline: words.headline.en, reasons: words.reasons.map((x) => x.en) };
      if (aloneVsTogether(r.facts, r.request, now, r).noneAloneButTogether) together = BUYER_SENTENCE.en;
    }
  }
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
      /** Only what the buyer needs: when PayPal captured the payment (never fees or maker payouts). */
      paidAt: plan.status === "paid" ? ((await paymentOf(d, plan.paymentRef))?.capturedAt ?? null) : null,
    };
  }
  return {
    id: order.id,
    collective: c.name,
    product: settingsOf(c).product.en,
    request: { quantity: spec.quantity, deadline: spec.deadline, budgetUsdCents: spec.budgetUsdCents, details: spec.details },
    status: order.status,
    revising: !!plan && (plan.status === "needs_replan" || plan.status === "maker_declined"),
    /** Before terms exist: the checked answer on today's facts. Not the terms; makers have not agreed yet. */
    firstCheck: plan ? null : firstCheck,
    /** Aggregate only, and only when every maker alone is a checked refusal and the group is a checked yes. */
    together,
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
  const shares = await shareSummaries(d, { memberId: member.id });
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
          /** The buyer has paid for the plan that includes exactly this part: she can start. */
          paid: !!plan?.partIds.has(p.id) && plan.status === "paid",
          share: shares.find((s) => s.partId === p.id) ?? null,
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
