import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/craft";
import { CopyText } from "@/components/copy-text";
import { PAGE } from "@/components/layout";

export const metadata: Metadata = {
  title: "Use your own AI agent · Haat",
  description: "Connect Claude, ChatGPT, Cursor or VS Code to Haat's MCP server and ask for a bulk order from an artisan collective.",
};

/** The public site URL, known at build time (Vercel sets its production domain). */
function siteUrl(): string {
  const explicit = process.env.APP_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  return vercel ? `https://${vercel}` : "http://localhost:3000";
}

const PROMPTS = [
  "Use Haat to ask the artisan collective whether they can make 30 hand block-printed indigo scarves, delivered in about four weeks, for around $300 in total. Show me exactly what you'll send and wait for my OK.",
  "What does the Haat collective make, and what's the earliest date they could deliver a bulk order?",
  "Check on my Haat order: <paste the order link or ID>",
] as const;

const AFTER = [
  ["The agent sends only what you confirmed", "It reads the collective's products and rules, restates quantity, date and budget, and sends the request after your OK."],
  ["You get a first answer and an order link", "Haat checks the request at once against the makers' recorded days, materials, prices and other promises: yes, no with what would work, or not yet. The agent sees only the overall answer, never a maker's name, days or pay."],
  ["The makers decide", "The coordinator shares the plan and each maker agrees to her own part on her own link. That takes a person, so the order waits for them."],
  ["You approve and pay with PayPal", "Once every maker has agreed, the order link shows the exact terms. You approve and pay there yourself; the agent can't pay."],
] as const;

export default function AgentPage() {
  const url = siteUrl();
  const endpoint = new URL(url);
  const needsPublicUrl = endpoint.protocol !== "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) || endpoint.hostname.endsWith(".localhost");
  const mcp = `${url}/api/mcp`;
  const cursorLink = `cursor://anysphere.cursor-deeplink/mcp/install?name=haat&config=${encodeURIComponent(Buffer.from(JSON.stringify({ url: mcp })).toString("base64"))}`;
  const vscodeLink = `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: "haat", type: "http", url: mcp }))}`;

  const clients: { name: string; steps: React.ReactNode; copy?: string; copyLabel?: string; button?: { href: string; label: string } }[] = [
    {
      name: "Claude (web or Desktop)",
      steps: (
        <>
          <b>Customize → Connectors → + Add → Add custom connector</b>. Name it <i>Haat</i>, paste the public HTTPS URL, and choose <b>No sign in</b> for authentication.
          Enable Haat in a new chat using <b>+ → Connectors</b>. On a managed workspace, an owner may need to add it first. See the{" "}
          <a href="https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp" className="underline underline-offset-4">official Claude setup guide</a>.
        </>
      ),
      copy: mcp,
      copyLabel: "Copy URL",
    },
    {
      name: "ChatGPT",
      steps: (
        <>
          Open <b>ChatGPT Plugins → + → Add custom MCP server</b>. Enter Haat&apos;s name, description and public HTTPS URL; select no authentication, review the warning,
          then choose <b>Create as a plugin</b>. In a new conversation, type <b>@</b> and select Haat. Availability depends on your account and workspace policies.
          Menus can change; see the <a href="https://developers.openai.com/plugins/deploy/connect-chatgpt" className="underline underline-offset-4">official OpenAI setup guide</a>.
        </>
      ),
      copy: mcp,
      copyLabel: "Copy URL",
    },
    {
      name: "Claude Code",
      steps: <>Run this in a terminal, then start <code className="font-mono">claude</code> and ask.</>,
      copy: `claude mcp add --transport http haat ${mcp}`,
    },
    {
      name: "Cursor",
      steps: <>Opens Cursor and asks you to install the Haat server. Or add it to <code className="font-mono">mcp.json</code> with this URL.</>,
      button: { href: cursorLink, label: "Add to Cursor" },
    },
    {
      name: "VS Code (Copilot agent mode)",
      steps: <>Opens VS Code and asks you to install the Haat server. Or add an <code className="font-mono">http</code> server with this URL.</>,
      button: { href: vscodeLink, label: "Add to VS Code" },
    },
  ];

  return (
    <>
      <SiteHeader />
      <main className={`${PAGE} flex-1 py-16 lg:py-20`}>
        <section className="mb-12 border border-line bg-paper-deep/60 p-6">
          <h2 className="font-display text-2xl">Try Haat—no setup</h2>
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted">
            Use the request form to describe a bulk order, review what AI understood, and get the same checked first answer. This uses Haat directly; connecting your own agent below is optional.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
            <Link href="/c/request" className="mt-5 inline-block bg-ink px-6 py-3 text-sm text-paper transition hover:bg-ink/85">Request a bulk order</Link>
            <a href="https://youtu.be/JWpLjkx_Hnk" target="_blank" rel="noopener noreferrer" className="text-sm underline underline-offset-4 hover:text-muted">Watch the 3-minute demo ↗</a>
          </div>
        </section>
        <div className="grid gap-x-16 gap-y-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
          <div className="min-w-0 lg:sticky lg:top-10 lg:self-start">
            <p className="eyebrow">Agentic commerce · MCP</p>
            <h1 className="mt-4 font-display text-4xl font-normal leading-tight lg:text-5xl">Ask through your own AI agent.</h1>
            <p className="mt-5 max-w-xl text-lg font-light leading-relaxed text-muted">
              Haat runs a public MCP server. Connect it to a compatible assistant you already use and ask for a bulk order in your own words.
              No Haat account is needed; your assistant or editor must support custom MCP servers and may require account access or workspace permission.
            </p>
            <div className="mt-8">
              <p className="eyebrow mb-2">Server URL</p>
              <CopyText text={mcp} label="Copy URL" />
              {needsPublicUrl && (
                <p className="mt-3 border-l-2 border-ink pl-3 text-sm leading-relaxed text-muted">
                  Local development: Claude&apos;s remote connector cannot reach localhost, and ChatGPT needs a public HTTPS endpoint or its supported tunnel.
                  Use the deployed site, or run <code className="font-mono">npm run tunnel</code> and use its HTTPS URL followed by <code className="font-mono">/api/mcp</code>.
                  To update all links on this page, set <code className="font-mono">APP_URL</code> to that HTTPS origin and restart development or rebuild production.
                </p>
              )}
            </div>
            <p className="mt-6 text-sm leading-relaxed text-muted">
              Prefer a form? <Link href="/c/request" className="text-ink underline underline-offset-4">Request a bulk order</Link> directly. Both reach the same checks.
            </p>
          </div>

          <ol className="min-w-0 divide-y divide-line border-y border-line">
            {clients.map((c, i) => (
              <li key={c.name} className="grid gap-3 py-6 sm:grid-cols-[2.5rem_1fr]">
                <span className="eyebrow pt-1">0{i + 1}</span>
                <div className="min-w-0 space-y-3">
                  <h2 className="font-display text-xl">{c.name}</h2>
                  <p className="text-sm leading-relaxed text-muted">{c.steps}</p>
                  {c.button && (
                    <a href={c.button.href} className="inline-block bg-ink px-5 py-2 text-xs tracking-wide text-paper transition hover:bg-ink/85">
                      {c.button.label}
                    </a>
                  )}
                  {c.copy && <CopyText text={c.copy} label={c.copyLabel} />}
                </div>
              </li>
            ))}
          </ol>
        </div>

        <section className="mt-20 grid gap-x-16 gap-y-10 border-t border-line pt-14 lg:grid-cols-2">
          <div className="min-w-0">
            <h2 className="font-display text-3xl font-normal">Then ask, for example</h2>
            <div className="mt-6 space-y-3">
              {PROMPTS.map((p) => (
                <CopyText key={p} text={p} mono={false} />
              ))}
            </div>
            <p className="mt-4 text-sm leading-relaxed text-muted">
              Tools the agent can use: <code className="font-mono">get_collective_info</code>, <code className="font-mono">request_collective_order</code>,{" "}
              <code className="font-mono">get_collective_order</code>.
            </p>
          </div>
          <div className="min-w-0">
            <h2 className="font-display text-3xl font-normal">What happens next</h2>
            <ol className="mt-6 space-y-6">
              {AFTER.map(([title, body], i) => (
                <li key={title} className="grid grid-cols-[2.5rem_1fr] gap-2">
                  <span className="eyebrow pt-1">0{i + 1}</span>
                  <span>
                    <span className="block font-display text-xl">{title}</span>
                    <span className="mt-1 block text-sm leading-relaxed text-muted">{body}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
