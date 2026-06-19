/**
 * Server-Sent-Events frame builders shared by the per-dialect streaming
 * renderers. Pure string formatting: no network, no SDK runtime.
 */

/** Build a default (no `event:`) SSE data frame for a JSON-serializable value. */
export function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Build a typed SSE frame (`event:` + `data:`), as Anthropic streaming uses. */
export function sseEvent(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}
