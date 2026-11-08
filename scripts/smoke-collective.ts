/**
 * End-to-end smoke test of a collective order against a DEPLOYED Haat (PayPal sandbox):
 *
 *   request → checked plan → each maker accepts on her own link → buyer approves →
 *   PayPal cancel + return pages → sandbox payment (a person approves it in PayPal) →
 *   capture and PayPal webhooks delivered → makers' shares → payout reported → maker confirms,
 *   with privacy checks on the buyer page, the agent (MCP) output and each maker's page.
 *
 *   SMOKE_PASSCODE=<studio PIN> npx tsx scripts/smoke-collective.ts https://<your-app>.vercel.app
 *   (SMOKE_STOP_AT_CHECKOUT=1 stops before the PayPal step: a dry run)
 *
 * It creates one real (sandbox) order named "Smoke test" and issues NEW personal links to the
 * makers in the plan (their old links stop working); the new links are printed at the end.
 * Nothing here can move real money: the app must be on the PayPal sandbox.
 */
import { config } from "dotenv";
import { createInterface } from "node:readline/promises";
import { randomInt } from "node:crypto";
config({ path: ".env.local", quiet: true });

const BASE = (process.argv[2] ?? "").replace(/\/$/, "");
const PASS = process.env.SMOKE_PASSCODE ?? process.env.SELLER_PASSCODE ?? "";
if (!/^https?:\/\//.test(BASE) || !PASS) {
  console.error("usage: SMOKE_PASSCODE=<studio PIN> npx tsx scripts/smoke-collective.ts https://<app>");
  process.exit(2);
}

type Check = { step: string; ok: boolean; detail: string };
const checks: Check[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  checks.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
  return ok;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let cookie = "";

async function call(path: string, body?: unknown, auth = false) {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped API responses in a test script
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new Error(`${path} → ${res.status} ${json.error ?? text.slice(0, 200)}`);
  return json;
}
const ask = async (q: string) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(q);
  rl.close();
  return a.trim().toLowerCase();
};
const leaks = (json: unknown, names: string[]) => {
  const s = JSON.stringify(json);
  return [...names.filter((n) => s.includes(n)), ...["₹", "askInr", "floorInr", "piecesPerWeekday", "payInr", "owedPaise", "UPI"].filter((k) => s.includes(k))];
};

async function main() {
  // 0. The deployed build.
  const health = await (await fetch(`${BASE}/api/health`)).json();
  check("deployed build is healthy and fully migrated", health.ok === true && health.migrations?.applied === health.migrations?.expected,
    `commit ${health.commit ?? "?"}, migrations ${health.migrations?.applied}/${health.migrations?.expected} (latest ${health.migrations?.latest})`);

  const login = await fetch(`${BASE}/api/seller/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passcode: PASS }) });
  cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  if (!check("coordinator can sign in", login.ok && !!cookie)) return;
  const home = await call("/api/seller/collective", undefined, true);
  const makerNames: string[] = home.members.map((m: { name: string }) => m.name);

  // 1. The buyer's request.
  const info = await call("/api/c/requests");
  const deadline = new Date(Date.parse(`${info.earliest}T00:00:00Z`) + 20 * 86_400_000).toISOString().slice(0, 10);
  const req = await call("/api/c/requests", { action: "send", text: `Smoke test: 30 scarves by ${deadline}`, quantity: 30, deadline, buyerName: "Smoke test", via: "form" });
  const orderId: string = req.id;
  check("buyer request accepted", !!orderId, `order ${orderId}, 30 by ${deadline}`);

  // 2. Checked plan, offered to makers.
  let iv = await call(`/api/seller/collective/orders/${orderId}`, undefined, true);
  if (!check("plan is a checked yes", iv.evaluation.kind === "feasible" && iv.evaluation.checked, iv.evaluation.headline?.en)) return;
  iv = await call(`/api/seller/collective/orders/${orderId}`, { action: "offer", choice: "primary" }, true);
  const parts: { memberId: string; name: string; partId: string }[] = iv.plan.parts;
  check("plan sent to the makers in it", parts.length > 0, parts.map((p) => p.name).join(", "));

  // 3. Each maker, on her own (new) link: privacy, then accept.
  const links: Record<string, string> = {};
  for (const p of parts) {
    const { path } = await call("/api/seller/collective", { action: "link", memberId: p.memberId }, true);
    links[p.name] = `${BASE}${path}`;
    const token = path.split("/").pop();
    const mv = await call(`/api/m/${token}`);
    const others = makerNames.filter((n) => n !== p.name);
    const mine = mv.parts.find((x: { status: string; orderRef: string }) => x.status === "pending" && orderId.startsWith(x.orderRef));
    check(`${p.name}'s link shows only her own part`, !!mine && others.every((n) => !JSON.stringify(mv.parts).includes(n)));
    await call(`/api/m/${token}`, { action: "respond", partId: mine.id, hash: mine.termsHash, answer: "accept" });
  }

  // 4. Buyer page and agent output: aggregate only.
  let bv = await call(`/api/c/orders/${orderId}`);
  check("buyer page reveals no maker name, price, availability or payout", leaks(bv, makerNames).length === 0, leaks(bv, makerNames).join(", "));
  check("every maker has confirmed; terms ready for the buyer", bv.offer?.status === "ready" && bv.offer.makersConfirmed === bv.offer.makers);
  try {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const client = new Client({ name: "haat-smoke", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/api/mcp`)));
    const out = await client.callTool({ name: "get_collective_order", arguments: { orderId } });
    const text = (out.content as { text: string }[])[0]?.text ?? "";
    check("agent (MCP) output is aggregate only", !out.isError && leaks(JSON.parse(text), makerNames).length === 0, leaks(JSON.parse(text), makerNames).join(", "));
    await client.close();
  } catch (e) {
    check("agent (MCP) output is aggregate only", false, (e as Error).message.slice(0, 120));
  }

  // 5. Buyer approves the exact terms; PayPal order for exactly those terms.
  bv = await call(`/api/c/orders/${orderId}`, { action: "approve", planId: bv.offer.id, hash: bv.offer.termsHash });
  check("buyer approval reserves capacity", bv.offer?.status === "approved", bv.offer?.holdUntil ? `held until ${bv.offer.holdUntil}` : "");
  const co = await call(`/api/c/orders/${orderId}`, { action: "checkout", planId: bv.offer.id, hash: bv.offer.termsHash });
  if (!check("PayPal checkout created", !!co.approveUrl)) return;

  if (process.env.SMOKE_STOP_AT_CHECKOUT === "1") {
    console.log("SMOKE_STOP_AT_CHECKOUT=1: stopping before the PayPal approval (dry run).");
    return;
  }
  console.log(`\nPayPal link: ${co.approveUrl}\n`);
  console.log(`1) CANCEL TEST: open the link, log in as the sandbox BUYER, then click "Cancel and return".`);
  console.log(`   You should land on ${BASE}/c/orders/${orderId}?paypal=cancel saying nothing was charged.`);
  check("cancel returns to this order's page, nothing charged", (await ask("   Did it? (y/n) ")) === "y");
  console.log(`2) PAY: open the same link again and approve the payment.`);
  console.log(`   You should land on ${BASE}/c/orders/${orderId}?checkout=done`);
  check("return lands on this order's page", (await ask("   Did it? (y/n) ")) === "y");

  // 6. Paid, captured, webhooks delivered.
  for (let i = 0; i < 60 && bv.offer?.status !== "paid"; i++) {
    await sleep(5000);
    bv = await call(`/api/c/orders/${orderId}`);
  }
  check("order is paid (PayPal capture completed)", bv.offer?.status === "paid", bv.offer?.paidAt ?? "");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped API response in a test script
  let pay: Record<string, any> | null = null;
  for (let i = 0; i < 36; i++) {
    iv = await call(`/api/seller/collective/orders/${orderId}`, undefined, true);
    pay = iv.plan?.payment;
    if (pay?.webhooks?.some((w: { type: string; processed: boolean }) => w.type === "PAYMENT.CAPTURE.COMPLETED" && w.processed)) break;
    await sleep(5000);
  }
  check("PayPal's own record: capture id, fee and net", !!pay?.captureId && pay?.status === "COMPLETED" && pay?.feeCents !== null, `capture ${pay?.captureId}, fee ${pay?.feeCents}¢, net ${pay?.netCents}¢`);
  check("PayPal webhook delivered and processed (PAYMENT.CAPTURE.COMPLETED)", !!pay?.webhooks?.some((w: { type: string; processed: boolean }) => w.type === "PAYMENT.CAPTURE.COMPLETED" && w.processed),
    (pay?.webhooks ?? []).map((w: { type: string; processed: boolean }) => `${w.type}${w.processed ? "" : " (unprocessed)"}`).join(", ") || "none received");

  // 7. Shares owed → payout reported → she confirms on her link.
  const shares: { shareId: string; name: string; owedPaise: number; settled: boolean }[] = iv.plan.shares;
  check("one share per maker, owed her agreed pay", shares.length === parts.length && shares.every((s) => s.owedPaise > 0), shares.map((s) => `${s.name} ₹${s.owedPaise / 100}`).join(", "));
  const first = shares[0];
  const reference = String(randomInt(100_000_000_000, 999_999_999_999)); // test UPI reference, not a real transfer
  iv = await call(`/api/seller/collective/orders/${orderId}`, { action: "report_payment", shareId: first.shareId, amountInr: first.owedPaise / 100, method: "upi", reference }, true);
  const token = links[first.name].split("/").pop();
  const mv = await call(`/api/m/${token}`);
  const reported = mv.parts.flatMap((p: { share: { payments: { id: string; status: string }[] } | null }) => p.share?.payments ?? []).find((x: { status: string }) => x.status === "reported");
  check(`${first.name} sees the reported payout on her link`, !!reported);
  await call(`/api/m/${token}`, { action: "payment", paymentId: reported.id, answer: "confirm" });
  iv = await call(`/api/seller/collective/orders/${orderId}`, undefined, true);
  check(`${first.name}'s share is settled only after she confirms`, iv.plan.shares.find((s: { shareId: string }) => s.shareId === first.shareId)?.settled === true);
  const others = makerNames.filter((n) => n !== first.name);
  check(`${first.name}'s page shows no other maker's pay`, others.every((n) => !JSON.stringify(mv).includes(n)));
  bv = await call(`/api/c/orders/${orderId}`);
  check("buyer page still shows no payouts", leaks(bv, makerNames).length === 0);

  console.log(`\nNew personal links issued (old ones no longer work):`);
  for (const [n, l] of Object.entries(links)) console.log(`  ${n}: ${l}`);
}

main()
  .catch((e) => check("smoke test ran to the end", false, (e as Error).message))
  .finally(() => {
    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
    process.exitCode = failed.length ? 1 : 0;
  });
