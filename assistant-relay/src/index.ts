/**
 * HTTP entrypoint. Streamable HTTP transport, stateless JSON — not SSE, not
 * stateful sessions (spec §4). Sessions live in the store, not the transport,
 * so each POST gets a fresh transport + server instance carrying the
 * authenticated caller.
 */
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { authenticate, AuthError } from "./auth.js";
import { buildServer } from "./server.js";
import { closePool } from "./db/pool.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ ok: true, server: "assistant-relay-mcp-server", phase: "1" });
});

app.post("/mcp", async (req: Request, res: Response) => {
  let caller;
  try {
    caller = await authenticate(req);
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 401;
    res.status(status).json(jsonRpcError(-32001, (e as Error).message));
    return;
  }

  // Stateless: new transport + server per request; nothing kept in memory.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const server = buildServer(caller);

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json(jsonRpcError(-32603, (e as Error).message));
    }
  }
});

// Stateless mode: GET/DELETE (SSE stream, session teardown) are not supported.
const rejectStateless = (_req: Request, res: Response) => {
  res.status(405).json(jsonRpcError(-32000, "Method not allowed: stateless server."));
};
app.get("/mcp", rejectStateless);
app.delete("/mcp", rejectStateless);

const httpServer = app.listen(config.port, () => {
  console.log(
    `assistant-relay-mcp-server listening on :${config.port} (Phase 1: T2)`,
  );
});

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

async function shutdown(): Promise<void> {
  httpServer.close();
  await closePool();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
