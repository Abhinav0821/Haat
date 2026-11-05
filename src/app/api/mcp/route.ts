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

export { handle as GET, handle as POST, handle as DELETE };
