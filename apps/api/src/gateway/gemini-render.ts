// apps/api/src/gateway/gemini-render.ts
//
// model-supply-greenfield 批次5 slice6 — the Gemini generateContent OUTPUT
// stage of the v2 chat surface: GatewayResponse → the `candidates[]` JSON,
// StreamFrame → the `alt=sse` candidate `data:` frames, and GatewayError → the
// Google `{error:{code, message, status}}` envelope.
//
// Wire framing is NOT re-derived here: the chat-ir-bridge converts the gateway
// IR to the llm-protocol chat IR, and the llm-protocol Gemini renderers
// produce the wire (复用 llm-protocol/gemini/render+stream).
import type { GatewayError, GatewayResponse, GatewayUsage, StreamFrame } from '@actionow/contracts';
import { renderGeminiChat, renderGeminiGenerateContentStream } from '@actionow/llm-protocol';
import type { Response } from 'express';

import { chatEventsOf, chatResponseOf } from './chat-ir-bridge.js';
import { statusForGatewayError } from './gateway-error.js';

/**
 * Render one sync chat GatewayResponse as a Gemini generateContent response.
 * The Gemini wire carries no top-level model field, so none is echoed.
 */
export function renderGeminiResponse(response: GatewayResponse): Record<string, unknown> {
  return renderGeminiResponseOf(response.output, response.usage);
}

/** The generateContent assembly, reusable for §5 idempotent replays (task-row output/usage). */
export function renderGeminiResponseOf(
  output: unknown,
  usage: GatewayUsage | undefined,
): Record<string, unknown> {
  return renderGeminiChat(chatResponseOf(output, usage));
}

/**
 * Render the IR StreamFrame sequence as Gemini `streamGenerateContent`
 * (`alt=sse`) frames. Gemini's SSE ends at stream close — no [DONE] sentinel;
 * a mid-stream gateway `error` frame becomes the terminal `finishReason:
 * 'OTHER'` candidate chunk (the llm-protocol Gemini stream semantics).
 */
export function renderGeminiSse(frames: AsyncIterable<StreamFrame>): AsyncIterable<string> {
  return renderGeminiGenerateContentStream(chatEventsOf(frames));
}

/** Frozen gateway taxonomy → the Google canonical error `status` string. */
export function geminiErrorStatusOf(code: GatewayError['code']): string {
  switch (code) {
    case 'invalid_input':
    case 'unsupported_parameter':
    case 'content_filtered':
      return 'INVALID_ARGUMENT';
    case 'unauthorized':
      return 'UNAUTHENTICATED';
    case 'forbidden':
      return 'PERMISSION_DENIED';
    case 'model_not_found':
    case 'task_not_found':
      return 'NOT_FOUND';
    case 'conflict':
      return 'ABORTED';
    case 'insufficient_credits':
    case 'rate_limited':
      return 'RESOURCE_EXHAUSTED';
    case 'upstream_error':
      return 'UNAVAILABLE';
    case 'upstream_timeout':
      return 'DEADLINE_EXCEEDED';
    default:
      return 'INTERNAL';
  }
}

/**
 * Write one gateway error in the Google `{error:{code, message, status}}`
 * envelope: HTTP status from the frozen taxonomy (echoed as the numeric
 * `code`, the Google wire convention), Retry-After on 429, the request id on
 * `x-request-id`.
 */
export function sendGeminiError(res: Response, error: GatewayError, requestId: string): void {
  const status = statusForGatewayError(error.code);
  if (status === 429 && error.retryAfterMs !== undefined) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
  }
  res.setHeader('x-request-id', requestId);
  res.status(status).json({
    error: { code: status, message: error.message, status: geminiErrorStatusOf(error.code) },
  });
}
