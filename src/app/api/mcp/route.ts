import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildMcpServer } from "@/lib/mcp/server";

/**
 * Remote MCP endpoint (Streamable HTTP, stateless). Add it to Claude / ChatGPT
 * as a custom connector: https://<host>/api/mcp
 */

function baseUrlOf(request: Request): string {
  const h = request.headers;
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

async function handle(request: Request): Promise<Response> {
  const clientKey = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0] ?? "local";
  const server = buildMcpServer({ baseUrl: baseUrlOf(request), clientKey });
  // Stateless: a fresh server + transport per request, JSON responses (no SSE needed).
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}

/**
 * Stateless JSON server: no server-to-client event stream. A GET would otherwise hold a
 * serverless function open until the platform's timeout, so it is refused per the spec.
 */
function noStream(): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless (POST only)." }, id: null }), {
    status: 405,
    headers: { "Content-Type": "application/json", Allow: "POST" },
  });
}

export { handle as POST, noStream as GET, noStream as DELETE };
