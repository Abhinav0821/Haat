/** Pilot-study metrics from logged events (pure; used by scripts/pilot-report.ts and tests). */
export type Ev = { name: string; props: Record<string, unknown>; at: string | Date };

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const secs = (ms: number | null) => (ms === null ? "n/a" : ms >= 120_000 ? `${(ms / 60_000).toFixed(1)} min` : `${Math.round(ms / 1000)} s`);

export function pilotSummary(rows: Ev[]) {
  const named = (n: string) => rows.filter((r) => r.name === n);
  const at = (r: Ev) => new Date(r.at).getTime();
  const lines: string[] = [];

  // Listing (T1–T3)
  const published = named("listing_published");
  const durations = published.map((r) => r.props.durationMs).filter((n): n is number => typeof n === "number");
  lines.push("— Listing (T1–T3)");
  lines.push(`rules approved: ${named("rules_approved").length}`);
  lines.push(`listings published: ${published.length}`);
  lines.push(`time to list (median): ${secs(median(durations))}  [${durations.map((d) => secs(d)).join(", ")}]`);
  lines.push(`voice corrections used: ${named("listing_corrected_by_voice").length}`);

  // Custom orders (T6)
  const created = named("custom_request_created");
  const drafted = named("custom_options_drafted");
  const sent = named("custom_options_sent");
  const counters = named("custom_counter");
  const approvals = named("agreement_approved");
  const byRequest = (ev: Ev[]) => new Map(ev.filter((e) => typeof e.props.requestId === "string").map((e) => [e.props.requestId as string, e]));
  const firstSent = new Map<string, Ev>();
  for (const e of sent) if (typeof e.props.requestId === "string" && !firstSent.has(e.props.requestId)) firstSent.set(e.props.requestId, e);
  const answerTimes = [...byRequest(created)].flatMap(([id, c]) => (firstSent.has(id) ? [at(firstSent.get(id)!) - at(c)] : []));
  const optionsDrafted = drafted.reduce((s, e) => s + (Number(e.props.options) || 0), 0);
  const optionsBlocked = drafted.reduce((s, e) => s + (Number(e.props.blocked) || 0), 0);
  lines.push("— Custom orders (T6)");
  lines.push(`requests received: ${created.length} (via AI agent: ${created.filter((e) => e.props.channel === "mcp").length})`);
  lines.push(`spoken answers: ${drafted.length} → options heard: ${optionsDrafted}, blocked by her own rules: ${optionsBlocked}`);
  lines.push(`requests answered (options sent): ${firstSent.size}; time from request to answer (median): ${secs(median(answerTimes))}`);
  lines.push(`counter-offers: ${counters.length} (refused automatically: ${counters.filter((e) => e.props.acceptable === false).length})`);
  lines.push(`agreements proposed: ${named("agreement_proposed").length}; approved by both: ${approvals.filter((e) => e.props.both === true).length}`);
  lines.push(`declined by the maker: ${named("custom_declined").length}; production updates: ${named("custom_progress").length}`);
  return lines;
}
