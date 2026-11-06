import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, lte, inArray, ne, or, sql } from "drizzle-orm";
import { db, schema, withTx, type DB, type Tx } from "@/db";
import { isCalendarDate } from "@/lib/calendar-date";
import { evaluate } from "@/lib/planner/solve";
import { checkEvaluation, checkPlan } from "@/lib/planner/check";
import { dayDate, dayIndex, factsHash, PLANNER_MODEL, type CollectiveFacts, type Evaluation, type OptimalityCert, type OrderRequest, type Plan } from "@/lib/planner/model";
import { buildFacts, materialsReadyOn, MemberFactsSchema, SettingsSchema, type CollectiveSettings, type DatedReservation, type MemberRow, type StoredMemberFacts } from "./facts";
import { buyerTerms, hasHindiRequirements, hashOf, partTerms, type PartTerms, type PlanTerms } from "./terms";

/**
 * Collective orders: allocation, per-maker consent and capacity reservations.
 *
 * Invariants (tested in tests/collective.test.mts):
 *  1. A plan is offered only if the planner's answer passes the independent checker.
 *  2. Each maker's part is immutable terms + hash; the plan's terms hash covers every
 *     part's id and hash. A new plan version reuses a part only when her terms are
 *     identical, so she is asked again exactly when HER part changed.
 *  3. Only her own response on her personal link counts. Link possession is not
 *     identity; it is recorded as "personal_link". No coordinator path accepts for her.
 *  4. The buyer can approve only the current version, with every part accepted on its
 *     current hash. Approval, the re-check against current facts and the capacity
 *     reservation happen in ONE transaction under a collective-level lock, so two
 *     orders can't both reserve the same finishing (or maker) capacity.
 *  5. Reservations count while approved-and-held, paying or paid. A maker withdrawing
 *     before payment releases them; after payment is outside this version.
 *
 * TRANSACTION LOCK ORDER: collective row → order row → plan rows → part rows.
 * Hold expiry alone is a conditional single-row update against its exact timestamp.
 */

export const HOLD_MS = 48 * 3600_000;

export class CollectiveError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

type PlanRow = typeof schema.collectivePlans.$inferSelect;
type PartRow = typeof schema.memberParts.$inferSelect;
type OrderRow = typeof schema.collectiveOrders.$inferSelect;
type CollectiveRow = typeof schema.collectives.$inferSelect;

export type OrderSpec = { quantity: number; deadline: string; budgetUsdCents: number | null; details: string | null; detailsHi?: string | null };
export type Choice = "primary" | "lowest_price" | "within_budget" | "largest_by_date" | "earliest";

/** The collective works on India's calendar (UTC+5:30, no daylight saving): a plan's dates are IST dates. */
export const LOCAL_OFFSET_MS = 330 * 60_000;
const today = (now: Date) => new Date(now.getTime() + LOCAL_OFFSET_MS).toISOString().slice(0, 10);
/** The instant a collective calendar date begins (midnight IST). */
export const dayBegins = (date: string) => Date.parse(`${date}T00:00:00Z`) - LOCAL_OFFSET_MS;
/** Plans start the day after they are made: nobody is asked for work on a day that is already under way. */
export const planStart = (now: Date) => dayDate(today(now), 1);

// ── Personal links ──────────────────────────────────────────────────────────

export const linkHash = (token: string) => createHash("sha256").update(`member-link:${token}`).digest("hex");
export const newLinkToken = () => randomBytes(24).toString("base64url");

export async function memberByLink(token: string, d?: DB | Tx) {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) throw new CollectiveError("This link isn't valid.", 404);
  const q = d ?? (await db());
  const [m] = await q.select().from(schema.members).where(eq(schema.members.linkHash, linkHash(token)));
  if (!m || !m.active) throw new CollectiveError("This link isn't valid.", 404);
  return m;
}

// ── Reading facts ───────────────────────────────────────────────────────────

export function settingsOf(c: CollectiveRow): CollectiveSettings {
  return SettingsSchema.parse(c.settings);
}
function memberRow(m: typeof schema.members.$inferSelect): MemberRow {
  return { id: m.id, name: m.name, facts: MemberFactsSchema.parse(m.facts) };
}

/** Plans whose capacity is held: approved and still within the hold, paying, or paid. */
export async function activeReservations(q: DB | Tx, collectiveId: string, now: Date, excludePlanId?: string): Promise<DatedReservation[]> {
  const rows = await q
    .select({ id: schema.collectivePlans.id, reserved: schema.collectivePlans.reserved })
    .from(schema.collectivePlans)
    .where(
      and(
        eq(schema.collectivePlans.collectiveId, collectiveId),
        or(inArray(schema.collectivePlans.status, ["paying", "paid"]), and(eq(schema.collectivePlans.status, "approved"), gt(schema.collectivePlans.holdUntil, now))),
        excludePlanId ? ne(schema.collectivePlans.id, excludePlanId) : undefined,
      ),
    );
  return rows.filter((r) => r.reserved).map((r) => r.reserved as unknown as DatedReservation);
}

async function currentFacts(q: DB | Tx, c: CollectiveRow, order: OrderRow, startDate: string, now: Date, excludePlanId?: string): Promise<CollectiveFacts> {
  const ms = await q.select().from(schema.members).where(and(eq(schema.members.collectiveId, c.id), eq(schema.members.active, 1))).orderBy(asc(schema.members.createdAt), asc(schema.members.id));
  return buildFacts(settingsOf(c), ms.map(memberRow), await activeReservations(q, c.id, now, excludePlanId), startDate, order.excludedMemberIds);
}

function specOf(order: OrderRow): OrderSpec {
  const s = order.spec as OrderSpec;
  return { quantity: s.quantity, deadline: s.deadline, budgetUsdCents: s.budgetUsdCents ?? null, details: s.details ?? null, detailsHi: s.detailsHi ?? null };
}

function requirements(details: string | null, detailsHi?: string | null) {
  if ((details !== null && typeof details !== "string") || (detailsHi != null && typeof detailsHi !== "string")) throw new CollectiveError("Requirements must be text.", 400);
  const en = details?.trim() || null, hi = detailsHi?.trim() || null;
  if ((en?.length ?? 0) > 300 || (hi?.length ?? 0) > 600) throw new CollectiveError("Keep requirements within 300 English / 600 Hindi characters.", 400);
  if (hi && (!en || !hasHindiRequirements({ details: en, detailsHi: hi }))) throw new CollectiveError("Provide the requirements in English and Hindi (Devanagari).", 400);
  return { details: en, detailsHi: hi };
}

export function requestFor(spec: OrderSpec, startDate: string): OrderRequest {
  return { quantity: spec.quantity, deliveryDay: dayIndex(startDate, spec.deadline), budgetUsdCents: spec.budgetUsdCents };
}

// ── Orders ──────────────────────────────────────────────────────────────────

export async function createOrder(collectiveId: string, input: { buyerText: string; buyerName?: string | null; buyerEmail?: string | null; channel?: string; spec: OrderSpec }) {
  const s = input.spec;
  if (!Number.isInteger(s.quantity) || s.quantity < 1 || s.quantity > 10_000) throw new CollectiveError("Quantity must be a whole number from 1 to 10,000.", 400);
  if (!isCalendarDate(s.deadline)) throw new CollectiveError("Use a real delivery date (YYYY-MM-DD).", 400);
  if (s.budgetUsdCents !== null && !(Number.isSafeInteger(s.budgetUsdCents) && s.budgetUsdCents > 0)) throw new CollectiveError("The budget must be a positive amount.", 400);
  const readings = requirements(s.details, s.detailsHi);
  const d = await db();
  const [o] = await d
    .insert(schema.collectiveOrders)
    .values({
      collectiveId,
      channel: input.channel ?? "web",
      buyerName: input.buyerName ?? null,
      buyerEmail: input.buyerEmail ?? null,
      buyerText: input.buyerText.slice(0, 2000),
      spec: { quantity: s.quantity, deadline: s.deadline, budgetUsdCents: s.budgetUsdCents, ...readings },
    })
    .returning();
  return o;
}

async function loadOrder(q: DB | Tx, orderId: string) {
  const [order] = await q.select().from(schema.collectiveOrders).where(eq(schema.collectiveOrders.id, orderId));
  if (!order) throw new CollectiveError("order not found", 404);
  const [c] = await q.select().from(schema.collectives).where(eq(schema.collectives.id, order.collectiveId));
  return { order, c };
}

export type Run = { facts: CollectiveFacts; request: OrderRequest; evaluation: Evaluation; problems: string[] };

/** Planner, then the independent checker. A rejected answer is never offered. */
export function run(facts: CollectiveFacts, request: OrderRequest, now: Date): Run {
  const evaluation = evaluate(facts, request, now);
  const problems = evaluation.kind === "unresolved" ? [] : checkEvaluation(facts, request, evaluation, now);
  return { facts, request, evaluation, problems };
}

/** Plan the order on today's facts and keep the result on record (model, facts hash, kind, checker verdict). */
export async function evaluateOrder(orderId: string, now = new Date(), ownPlanId?: string): Promise<Run & { order: OrderRow; collective: CollectiveRow }> {
  const d = await db();
  const { order, c } = await loadOrder(d, orderId);
  const startDate = planStart(now);
  // This order's own hold (if any) is not counted against it: the question is what the collective could do for it.
  const facts = await currentFacts(d, c, order, startDate, now, ownPlanId);
  const r = run(facts, requestFor(specOf(order), startDate), now);
  await d
    .update(schema.collectiveOrders)
    .set({
      lastEvaluation: { model: PLANNER_MODEL, at: now.toISOString(), factsHash: factsHash(r.facts, r.request), kind: r.evaluation.kind, checked: r.evaluation.kind !== "unresolved" && r.problems.length === 0, problems: r.problems.slice(0, 5) },
    })
    .where(eq(schema.collectiveOrders.id, orderId));
  return { ...r, order, collective: c };
}

/** The plan behind each offerable answer, with the request it is bound to. */
export function chosen(ev: Evaluation, request: OrderRequest, choice: Choice): { plan: Plan; optimality: OptimalityCert | null; certified: boolean; request: OrderRequest } | null {
  const bound = (p: Plan) => ({ quantity: p.quantity, deliveryDay: p.deliveryDay, budgetUsdCents: request.budgetUsdCents });
  if (choice === "primary" && ev.kind === "feasible") return { plan: ev.plan, optimality: ev.optimality, certified: ev.certified, request };
  if (choice === "lowest_price" && ev.kind === "infeasible_budget") return { plan: ev.plan, optimality: ev.optimality, certified: ev.certified, request };
  if (choice === "within_budget" && ev.kind === "infeasible_budget") {
    const lw = ev.alternatives.largestWithinBudget;
    if (lw && lw.quantity > 0 && "plan" in lw) return { plan: lw.plan, optimality: lw.optimality, certified: lw.certified, request: bound(lw.plan) };
  }
  if (choice === "largest_by_date" && ev.kind === "infeasible_capacity") {
    const lb = ev.alternatives.largestByDate;
    if (lb?.plan) return { plan: lb.plan, optimality: lb.optimality, certified: lb.certified, request: bound(lb.plan) };
  }
  if (choice === "earliest" && ev.kind === "infeasible_capacity") {
    const ed = ev.alternatives.earliestDelivery;
    if (ed?.kind === "found") return { plan: ed.plan, optimality: ed.optimality, certified: ed.certified, request: bound(ed.plan) };
  }
  return null;
}

const lockCollective = (tx: Tx, id: string) => tx.execute(sql`select id from collectives where id = ${id} for update`);
const lockOrder = (tx: Tx, id: string) => tx.execute(sql`select id from collective_orders where id = ${id} for update`);
const lockPlans = (tx: Tx, orderId: string) => tx.execute(sql`select id from collective_plans where order_id = ${orderId} for update`);
const lockParts = (tx: Tx, orderId: string) => tx.execute(sql`select id from member_parts where order_id = ${orderId} for update`);

/** Every lock for one order, in the one order used everywhere: collective, order, plans, parts. */
export async function lockOrderTree(tx: Tx, orderId: string) {
  const [ref] = await tx.select({ collectiveId: schema.collectiveOrders.collectiveId }).from(schema.collectiveOrders).where(eq(schema.collectiveOrders.id, orderId)); // immutable
  if (!ref) throw new CollectiveError("order not found", 404);
  await lockCollective(tx, ref.collectiveId);
  await lockOrder(tx, orderId);
  await lockPlans(tx, orderId);
  await lockParts(tx, orderId);
  return ref.collectiveId;
}
export { lockCollective };

export const LIVE: PlanRow["status"][] = ["awaiting_makers", "ready", "maker_declined", "approved", "needs_replan"];

/** Test-only pause points to force interleavings. */
export type Hooks = { afterRead?: () => Promise<void>; afterFactsRead?: () => Promise<void> };

/**
 * Offer one checked answer to the makers: a new plan version. Parts whose terms are
 * unchanged are reused (with her earlier acceptance); changed parts are new versions
 * and must be accepted again; parts no longer needed are superseded.
 */
export async function offerPlan(orderId: string, choice: Choice, now = new Date(), hooks: Hooks = {}) {
  return withTx(async (tx) => {
    const { c: ref } = await loadOrder(tx, orderId);
    await lockCollective(tx, ref.id); // facts read below include other plans' reservations
    await lockOrder(tx, orderId);
    await lockPlans(tx, orderId);
    await lockParts(tx, orderId);
    const { c } = await loadOrder(tx, orderId); // re-read settings after taking the lock
    const plans = await tx.select().from(schema.collectivePlans).where(eq(schema.collectivePlans.orderId, orderId)).orderBy(desc(schema.collectivePlans.version));
    if (plans.some((p) => p.status === "paying")) throw new CollectiveError("A payment for this order is being processed — the plan can't change now.");
    if (plans.some((p) => p.status === "paid")) throw new CollectiveError("This order is already paid.");
    const [fresh] = await tx.select().from(schema.collectiveOrders).where(eq(schema.collectiveOrders.id, orderId));
    const spec = specOf(fresh);
    if (!hasHindiRequirements(spec)) throw new CollectiveError("Add and review the Hindi requirements before sending a plan to makers.", 400);
    const startDate = planStart(now);
    const current = plans.find((p) => LIVE.includes(p.status));
    const facts = await currentFacts(tx, c, fresh, startDate, now, current?.id);
    const r = run(facts, requestFor(spec, startDate), now);
    await hooks.afterRead?.();
    if (r.evaluation.kind === "unresolved") throw new CollectiveError(`Not decided yet: ${r.evaluation.issues.map((i) => i.en).join(" ")}`);
    if (r.problems.length) throw new CollectiveError(`The independent checker rejected the planner's answer (${r.problems.slice(0, 2).join("; ")}). Nothing was offered.`, 500);
    const pick = chosen(r.evaluation, r.request, choice);
    if (!pick) throw new CollectiveError("That answer isn't available for this order now.", 400);
    const planProblems = checkPlan(facts, pick.request, pick.plan, now);
    if (planProblems.length) throw new CollectiveError(`The independent checker rejected the plan (${planProblems.slice(0, 2).join("; ")}).`, 500);

    const settings = settingsOf(c);
    const ctx = { collective: c.name, orderRef: orderId.slice(0, 8), product: settings.product, details: spec.details, detailsHi: spec.detailsHi, transitDays: settings.transitDays };
    const existing = await tx.select().from(schema.memberParts).where(eq(schema.memberParts.orderId, orderId));
    const producing = [...new Set(pick.plan.production.map((p) => p.makerId))].sort();
    const refs: PlanTerms["parts"] = [];
    for (const memberId of producing) {
      const terms = partTerms(pick.plan, startDate, memberId, ctx)!;
      const termsHash = hashOf(terms);
      const mine = existing.filter((p) => p.memberId === memberId).sort((a, b) => b.version - a.version);
      const live = mine.find((p) => p.status === "pending" || p.status === "accepted");
      if (live && live.termsHash === termsHash) {
        refs.push({ memberId, partId: live.id, termsHash });
        continue;
      }
      const [part] = await tx
        .insert(schema.memberParts)
        .values({ orderId, memberId, version: (mine[0]?.version ?? 0) + 1, terms: terms as unknown as Record<string, unknown>, termsHash, status: "pending" })
        .returning();
      if (live) await tx.update(schema.memberParts).set({ status: "superseded", supersededById: part.id }).where(eq(schema.memberParts.id, live.id));
      refs.push({ memberId, partId: part.id, termsHash });
    }
    // Makers no longer in the plan: their open parts are superseded (shown to them as "no longer needed").
    const keep = new Set(refs.map((x) => x.partId));
    for (const p of existing) {
      if ((p.status === "pending" || p.status === "accepted") && !keep.has(p.id)) await tx.update(schema.memberParts).set({ status: "superseded" }).where(eq(schema.memberParts.id, p.id));
    }

    const terms: PlanTerms = {
      buyer: buyerTerms(pick.plan, startDate, { ...ctx, requested: { quantity: spec.quantity, deadline: spec.deadline, budgetUsdCents: spec.budgetUsdCents } }),
      parts: refs,
    };
    const accepted = await partsAllAccepted(tx, refs);
    const [created] = await tx
      .insert(schema.collectivePlans)
      .values({
        orderId,
        collectiveId: c.id,
        version: (plans[0]?.version ?? 0) + 1,
        choice,
        facts: facts as unknown as Record<string, unknown>,
        request: pick.request as unknown as Record<string, unknown>,
        plan: pick.plan as unknown as Record<string, unknown>,
        optimality: pick.optimality as unknown as Record<string, unknown> | null,
        certified: pick.certified ? 1 : 0,
        terms: terms as unknown as Record<string, unknown>,
        termsHash: hashOf(terms),
        status: accepted ? "ready" : "awaiting_makers",
      })
      .returning();
    if (current) await tx.update(schema.collectivePlans).set({ status: "superseded", supersededById: created.id }).where(eq(schema.collectivePlans.id, current.id));
    await tx.update(schema.collectiveOrders).set({ status: "offered", updatedAt: now }).where(eq(schema.collectiveOrders.id, orderId));
    return created;
  });
}

/** Every referenced part is accepted, by her, on exactly the referenced hash. */
export async function partsAllAccepted(q: DB | Tx, refs: PlanTerms["parts"]): Promise<boolean> {
  if (!refs.length) return false;
  const rows = await q.select().from(schema.memberParts).where(inArray(schema.memberParts.id, refs.map((r) => r.partId)));
  return refs.every((r) => {
    const p = rows.find((x) => x.id === r.partId);
    return !!p && p.memberId === r.memberId && p.status === "accepted" && p.termsHash === r.termsHash && p.respondedHash === r.termsHash && p.respondedVia === "personal_link"
      && hashOf(p.terms) === p.termsHash && hasHindiRequirements(p.terms as unknown as PartTerms);
  });
}

/** The live (not superseded) plan for an order, after lapsing an expired hold. */
export async function currentPlan(q: DB | Tx, orderId: string, now = new Date(), hooks: Hooks = {}): Promise<PlanRow | undefined> {
  const [p] = await q
    .select()
    .from(schema.collectivePlans)
    .where(and(eq(schema.collectivePlans.orderId, orderId), inArray(schema.collectivePlans.status, [...LIVE, "paying", "paid"])))
    .orderBy(desc(schema.collectivePlans.version))
    .limit(1);
  await hooks.afterRead?.();
  if (p?.status === "approved" && p.holdUntil && p.holdUntil <= now) {
    // The hold lapsed unpaid: capacity is released; the makers' acceptances stand, and the buyer approves again (which re-checks).
    const [lapsed] = await q
      .update(schema.collectivePlans)
      .set({ status: "ready", buyerApprovedHash: null, buyerApprovedAt: null, holdUntil: null, statusNote: "The buyer's approval lapsed unpaid; capacity was released." })
      .where(and(eq(schema.collectivePlans.id, p.id), eq(schema.collectivePlans.status, "approved"), eq(schema.collectivePlans.holdUntil, p.holdUntil), lte(schema.collectivePlans.holdUntil, now)))
      .returning();
    return lapsed ?? currentPlan(q, orderId, now);
  }
  return p;
}

// ── Her response, on her personal link ──────────────────────────────────────

export async function respondToPart(token: string, partId: string, hash: string, answer: "accept" | "decline", note: string | null = null, now = new Date()) {
  const member = await memberByLink(token);
  const [ref] = await (await db()).select({ orderId: schema.memberParts.orderId }).from(schema.memberParts).where(eq(schema.memberParts.id, partId));
  if (!ref) throw new CollectiveError("This part wasn't found.", 404);
  return withTx(async (tx) => {
    await lockCollective(tx, member.collectiveId);
    await lockOrder(tx, ref.orderId);
    await lockPlans(tx, ref.orderId);
    await lockParts(tx, ref.orderId);
    await memberByLink(token, tx); // a link revoked while waiting cannot answer
    const [part] = await tx.select().from(schema.memberParts).where(eq(schema.memberParts.id, partId));
    if (!part || part.memberId !== member.id) throw new CollectiveError("This part wasn't found.", 404); // never reveal another maker's part
    if (part.status === "superseded") throw new CollectiveError("This part was changed. Please look at the latest version.");
    if (part.status === "declined") throw new CollectiveError("You already said no to this part.");
    if (hash !== part.termsHash) throw new CollectiveError("The terms changed since you saw them. Please look again.");
    if (answer === "accept" && !hasHindiRequirements(part.terms as unknown as PartTerms)) throw new CollectiveError("The Hindi requirements are missing. Ask the coordinator for a new version.");
    if (answer === "accept" && part.status === "accepted") return part;

    const plan = await currentPlan(tx, ref.orderId, now);
    const inPlan = plan && (plan.terms as PlanTerms).parts.some((p) => p.partId === part.id);
    if (plan && inPlan && (plan.status === "paying" || plan.status === "paid")) {
      throw new CollectiveError(plan.status === "paid" ? "This order is paid. To change your part, talk to the coordinator." : "The buyer's payment is being processed — please wait a moment.");
    }
    const [updated] = await tx
      .update(schema.memberParts)
      .set({
        status: answer === "accept" ? "accepted" : "declined",
        respondedHash: part.termsHash,
        respondedAt: now,
        respondedVia: "personal_link",
        responseNote: note?.slice(0, 500) || null,
      })
      .where(eq(schema.memberParts.id, part.id))
      .returning();
    if (plan && inPlan) {
      if (answer === "decline") {
        // Any hold is released by the status change. She is never silently replaced: the coordinator re-plans explicitly.
        await tx
          .update(schema.collectivePlans)
          .set({ status: "maker_declined", statusNote: `${member.name} said no to her part.`, buyerApprovedHash: null, buyerApprovedAt: null, holdUntil: null })
          .where(eq(schema.collectivePlans.id, plan.id));
      } else if (plan.status === "awaiting_makers" && (await partsAllAccepted(tx, (plan.terms as PlanTerms).parts))) {
        await tx.update(schema.collectivePlans).set({ status: "ready" }).where(eq(schema.collectivePlans.id, plan.id));
      }
    }
    return updated;
  });
}

/** Her facts, stated by her (on her link) or entered by the coordinator (an estimate until she confirms). */
export async function updateMemberFacts(memberId: string, input: unknown, by: { source: "maker_confirmed" | "coordinator_entered"; name: string }, now = new Date(), hooks: Hooks = {}) {
  const parsed = MemberFactsSchema.safeParse({ ...(input as object), prov: { source: by.source, by: by.name, at: now.toISOString() } });
  if (!parsed.success) throw new CollectiveError(parsed.error.issues[0]?.message ?? "Those facts aren't valid.", 400);
  const d = await db();
  const [ref] = await d.select({ collectiveId: schema.members.collectiveId }).from(schema.members).where(eq(schema.members.id, memberId));
  if (!ref) throw new CollectiveError("maker not found", 404);
  return withTx(async (tx) => {
    await lockCollective(tx, ref.collectiveId);
    const [m] = await tx.select().from(schema.members).where(eq(schema.members.id, memberId));
    if (!m) throw new CollectiveError("maker not found", 404);
    const old = MemberFactsSchema.parse(m.facts);
    const next = parsed.data;
    // Absolute dates survive confirmations and unrelated edits. Legacy clients
    // changing the delay state a new delay as of this update, not the old plan.
    if (next.materialsReadyDate === undefined) next.materialsReadyDate = next.materialsDays !== old.materialsDays
      ? (next.materialsDays === null ? null : dayDate(today(now), next.materialsDays)) : materialsReadyOn(old);
    const comparable = (f: StoredMemberFacts) => ({ ...f, prov: null, materialsDays: null, materialsReadyDate: materialsReadyOn(f) });
    const changed = hashOf(comparable(old)) !== hashOf(comparable(next));
    await hooks.afterRead?.();
    if (changed) {
      const plans = await tx.select().from(schema.collectivePlans).where(and(eq(schema.collectivePlans.collectiveId, ref.collectiveId), inArray(schema.collectivePlans.status, ["awaiting_makers", "ready", "approved", "paying"])));
      const affected = plans.filter((p) => (p.terms as unknown as PlanTerms).parts.some((r) => r.memberId === memberId));
      if (affected.some((p) => p.status === "paying")) throw new CollectiveError("A payment involving this maker is being processed. Wait before changing her facts.");
      for (const p of affected.sort((a, b) => a.orderId.localeCompare(b.orderId))) {
        await lockOrder(tx, p.orderId); await lockPlans(tx, p.orderId); await lockParts(tx, p.orderId);
        await invalidatePlan(tx, p, "A maker's facts changed; the coordinator must send a newly checked plan.", now);
      }
    }
    const [updated] = await tx.update(schema.members).set({ facts: next as unknown as Record<string, unknown> }).where(eq(schema.members.id, memberId)).returning();
    return updated;
  });
}

async function invalidatePlan(tx: Tx, p: PlanRow, note: string, now: Date) {
  await tx.update(schema.collectivePlans).set({ status: "needs_replan", statusNote: note, buyerApprovedHash: null, buyerApprovedAt: null, holdUntil: null, reserved: null })
    .where(and(eq(schema.collectivePlans.id, p.id), inArray(schema.collectivePlans.status, ["awaiting_makers", "ready", "approved"])));
  await tx.update(schema.collectiveOrders).set({ status: "offered", updatedAt: now }).where(and(eq(schema.collectiveOrders.id, p.orderId), inArray(schema.collectiveOrders.status, ["new", "offered", "approved"])));
}

/** Review both readings before offering. Existing parts stay immutable and are re-versioned. */
export async function updateOrderRequirements(orderId: string, details: string | null, detailsHi: string | null, now = new Date()) {
  const readings = requirements(details, detailsHi);
  if (!hasHindiRequirements(readings)) throw new CollectiveError("Add the Hindi requirements before saving.", 400);
  return withTx(async (tx) => {
    const { c: ref } = await loadOrder(tx, orderId);
    await lockCollective(tx, ref.id); await lockOrder(tx, orderId); await lockPlans(tx, orderId); await lockParts(tx, orderId);
    const { order } = await loadOrder(tx, orderId);
    const plans = await tx.select().from(schema.collectivePlans).where(eq(schema.collectivePlans.orderId, orderId));
    if (plans.some((p) => p.status === "paying" || p.status === "paid")) throw new CollectiveError("Requirements cannot change during or after payment.");
    const spec = specOf(order);
    if (spec.details === readings.details && spec.detailsHi === readings.detailsHi) return order;
    for (const p of plans.filter((p) => LIVE.includes(p.status))) await invalidatePlan(tx, p, "The bilingual requirements changed; a new plan and approvals are needed.", now);
    const [updated] = await tx.update(schema.collectiveOrders).set({ spec: { ...spec, ...readings }, updatedAt: now }).where(eq(schema.collectiveOrders.id, orderId)).returning();
    return updated;
  });
}

/** After a maker declines, the coordinator may leave her out of re-planning. Recorded on the order, never silent. */
export async function excludeMember(orderId: string, memberId: string) {
  return withTx(async (tx) => {
    const { c } = await loadOrder(tx, orderId);
    await lockCollective(tx, c.id);
    await lockOrder(tx, orderId);
    const [o] = await tx.select().from(schema.collectiveOrders).where(eq(schema.collectiveOrders.id, orderId));
    if (!o) throw new CollectiveError("order not found", 404);
    const declined = await tx.select().from(schema.memberParts).where(and(eq(schema.memberParts.orderId, orderId), eq(schema.memberParts.memberId, memberId), eq(schema.memberParts.status, "declined")));
    if (!declined.length) throw new CollectiveError("Only a maker who said no to her part can be left out.", 400);
    if (o.excludedMemberIds.includes(memberId)) return o;
    const [u] = await tx.update(schema.collectiveOrders).set({ excludedMemberIds: [...o.excludedMemberIds, memberId], updatedAt: new Date() }).where(eq(schema.collectiveOrders.id, orderId)).returning();
    return u;
  });
}

// ── The buyer approves: consent, re-check and reservation in one transaction ──

/** First calendar date with any work (a maker's or finishing) in the plan. */
export function firstWorkDate(p: Plan, startDate: string): string {
  return dayDate(startDate, Math.min(...p.production.map((x) => x.day), ...p.finishing.map((x) => x.day)));
}

/**
 * An unpaid hold ends after 48 hours or when the first work day starts, whichever is
 * first: makers start only once the buyer has paid, so a plan unpaid by then can't be kept.
 */
export function holdEnd(p: Plan, startDate: string, now: Date): Date {
  return new Date(Math.min(now.getTime() + HOLD_MS, dayBegins(firstWorkDate(p, startDate))));
}

class RecheckFailed extends Error {}

export async function buyerApprove(planId: string, hash: string, now = new Date(), hooks: Hooks = {}) {
  const d = await db();
  const [ref] = await d.select({ orderId: schema.collectivePlans.orderId, collectiveId: schema.collectivePlans.collectiveId }).from(schema.collectivePlans).where(eq(schema.collectivePlans.id, planId));
  if (!ref) throw new CollectiveError("These terms weren't found.", 404);
  try {
    return await withTx(async (tx) => {
      await lockCollective(tx, ref.collectiveId); // one reservation per collective at a time
      await lockOrder(tx, ref.orderId);
      await lockPlans(tx, ref.orderId);
      await lockParts(tx, ref.orderId);
      const plan = await currentPlan(tx, ref.orderId, now);
      if (!plan || plan.id !== planId) throw new CollectiveError("These terms were replaced by a newer version. Please review the latest terms.");
      if (plan.status === "approved") {
        if (plan.buyerApprovedHash === hash) {
          if (!(await partsAllAccepted(tx, (plan.terms as unknown as PlanTerms).parts))) throw new CollectiveError("Maker consent or Hindi requirements need a new plan.");
          return plan;
        }
        throw new CollectiveError("The terms changed since you viewed them. Please review again.");
      }
      if (plan.status === "paying" || plan.status === "paid") throw new CollectiveError("This order is already being paid.");
      if (plan.status === "awaiting_makers") throw new CollectiveError("Not every maker has confirmed her part yet.");
      if (plan.status !== "ready") throw new CollectiveError("These terms are being revised. Please wait for the new terms.");
      if (hash !== plan.termsHash) throw new CollectiveError("The terms changed since you viewed them. Please review again.");
      const terms = plan.terms as unknown as PlanTerms;
      if (!(await partsAllAccepted(tx, terms.parts))) throw new CollectiveError("Not every maker has confirmed her part yet.");

      // Re-check the exact plan against the facts as they are NOW (other orders' holds included).
      const { order, c } = await loadOrder(tx, ref.orderId);
      const p = plan.plan as unknown as Plan;
      const request = plan.request as unknown as OrderRequest;
      const startDate = (plan.facts as unknown as CollectiveFacts).startDate;
      const firstDay = dayIndex(startDate, planStart(now)); // tomorrow, as when planning
      await hooks.afterRead?.();
      if (p.production.some((x) => x.day < firstDay) || p.finishing.some((x) => x.day < firstDay)) throw new RecheckFailed("work scheduled for a day that has already started");
      const facts = await currentFacts(tx, c, order, startDate, now, plan.id);
      await hooks.afterFactsRead?.();
      const problems = checkPlan(facts, request, { ...p, factsHash: factsHash(facts, request) }, now);
      if (problems.length) throw new RecheckFailed(problems.slice(0, 2).join("; "));

      const reserved: DatedReservation = {
        planId: plan.id,
        production: p.production.map((x) => ({ memberId: x.makerId, date: dayDate(startDate, x.day), pieces: x.pieces })),
        finishing: p.finishing.map((x) => ({ date: dayDate(startDate, x.day), pieces: x.pieces })),
      };
      const [approved] = await tx
        .update(schema.collectivePlans)
        .set({ status: "approved", buyerApprovedHash: hash, buyerApprovedAt: now, holdUntil: holdEnd(p, startDate, now), reserved: reserved as unknown as Record<string, unknown>, statusNote: null })
        .where(and(eq(schema.collectivePlans.id, plan.id), eq(schema.collectivePlans.status, "ready")))
        .returning();
      if (!approved) throw new CollectiveError("The terms changed while approving — please try again.");
      await tx.update(schema.collectiveOrders).set({ status: "approved", updatedAt: now }).where(eq(schema.collectiveOrders.id, ref.orderId));
      return approved;
    });
  } catch (e) {
    if (!(e instanceof RecheckFailed)) throw e;
    await d
      .update(schema.collectivePlans)
      .set({ status: "needs_replan", statusNote: `No longer fits current facts: ${e.message}` })
      .where(and(eq(schema.collectivePlans.id, planId), eq(schema.collectivePlans.status, "ready")));
    throw new CollectiveError("The collective's schedule changed since these terms were made, so they can't be reserved. The coordinator will send revised terms; nothing was charged.");
  }
}

// ── Views ───────────────────────────────────────────────────────────────────

export type PartStatus = { memberId: string; name: string; partId: string; version: number; status: PartRow["status"]; respondedAt: string | null; via: string | null; note: string | null; pieces: number; payInr: number; reused: boolean };

export async function partStatuses(q: DB | Tx, plan: PlanRow): Promise<PartStatus[]> {
  const refs = (plan.terms as unknown as PlanTerms).parts;
  if (!refs.length) return [];
  const rows = await q.select().from(schema.memberParts).where(inArray(schema.memberParts.id, refs.map((r) => r.partId)));
  const ms = await q.select({ id: schema.members.id, name: schema.members.name }).from(schema.members).where(inArray(schema.members.id, refs.map((r) => r.memberId)));
  return refs.map((r) => {
    const p = rows.find((x) => x.id === r.partId)!;
    const t = p.terms as unknown as PartTerms;
    return {
      memberId: r.memberId,
      name: ms.find((m) => m.id === r.memberId)?.name ?? "?",
      partId: p.id,
      version: p.version,
      status: p.status,
      respondedAt: p.respondedAt?.toISOString() ?? null,
      via: p.respondedVia,
      note: p.responseNote,
      pieces: t.pieces,
      payInr: t.payInr,
      reused: p.createdAt < plan.createdAt,
    };
  });
}

export type { StoredMemberFacts };
