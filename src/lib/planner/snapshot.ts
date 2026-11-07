import { createHash } from "node:crypto";
import { canonical } from "@/lib/passport/signing";
import { checkInputs } from "./check-input";
import { factsHash, type CollectiveFacts, type OrderRequest } from "./model";

/** Coordinator-only, frozen inputs for both rounds of a role-play. Contains private maker facts. */
export type PlanningSnapshot = {
  v: 1;
  at: string;
  facts: CollectiveFacts;
  request: OrderRequest;
  fingerprint: string;
  factsFingerprint: string;
  source?: { orderId: string; offeredFactsHash: string | null; evaluatedFactsHash?: string | null };
};

const digest = (s: Pick<PlanningSnapshot, "v" | "at" | "facts" | "request">) => createHash("sha256").update(canonical({ v: s.v, at: s.at, facts: s.facts, request: s.request })).digest("hex");

export function createSnapshot(facts: CollectiveFacts, request: OrderRequest, at: Date, source?: PlanningSnapshot["source"]): PlanningSnapshot {
  const data = JSON.parse(JSON.stringify({ v: 1, at: at.toISOString(), facts, request, ...(source ? { source } : {}) }));
  return parseSnapshot({ ...data, fingerprint: digest(data), factsFingerprint: factsHash(data.facts, data.request) });
}

export function parseSnapshot(value: unknown): PlanningSnapshot {
  if (!value || typeof value !== "object") throw new Error("A saved evaluation scenario is required.");
  const s = value as PlanningSnapshot;
  if (s.v !== 1 || typeof s.at !== "string" || !Number.isFinite(Date.parse(s.at))) throw new Error("Invalid evaluation scenario version/time.");
  const problems = checkInputs(s.facts, s.request, new Date(s.at));
  if (problems.length) throw new Error(`Invalid scenario inputs: ${problems.slice(0, 3).join("; ")}`);
  if (s.fingerprint !== digest(s) || s.factsFingerprint !== factsHash(s.facts, s.request)) throw new Error("Scenario inputs changed: export a new scenario for both rounds.");
  return s;
}
