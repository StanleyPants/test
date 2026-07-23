/**
 * Helpers to turn handler outcomes into MCP tool results. Errors become
 * isError results whose text carries the actionable `next` hint (§15).
 */
import { RelayError } from "../errors.js";

export interface ToolResult {
  // Index signature required to satisfy the SDK's CallToolResult type.
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function ok(
  structured: Record<string, unknown>,
  summary?: string,
): ToolResult {
  return {
    content: [
      { type: "text", text: summary ?? JSON.stringify(structured) },
    ],
    structuredContent: structured,
  };
}

export function fail(e: unknown): ToolResult {
  if (e instanceof RelayError) {
    return {
      content: [{ type: "text", text: e.toToolText() }],
      structuredContent: { error: e.code, message: e.message, next: e.next ?? null },
      isError: true,
    };
  }
  const message = e instanceof Error ? e.message : String(e);
  return {
    content: [{ type: "text", text: `Internal error: ${message}` }],
    structuredContent: { error: "internal", message },
    isError: true,
  };
}

/** Wrap an async handler so thrown RelayErrors become actionable tool results. */
export function guard(
  fn: () => Promise<ToolResult>,
): () => Promise<ToolResult> {
  return async () => {
    try {
      return await fn();
    } catch (e) {
      return fail(e);
    }
  };
}
