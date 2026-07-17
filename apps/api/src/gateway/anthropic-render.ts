// apps/api/src/gateway/anthropic-render.ts
//
// model-supply-greenfield 批次5 slice6 — the Anthropic Messages OUTPUT stage
// of the v2 chat surface: GatewayResponse → the `type:'message'` JSON,
// StreamFrame → the typed Anthropic SSE events (message_start /
// content_block_delta / message_delta / message_stop), and GatewayError → the
// Anthropic `{type:'error', error:{type, message}}` envelope.
//
// Wire framing is NOT re-derived here: the chat-ir-bridge converts the gateway
// IR to the llm-protocol chat IR, and the battle-tested llm-protocol Anthropic
// renderers produce the wire (复用 llm-protocol/anthropic/render+stream).
import type { GatewayError, GatewayResponse, GatewayUsage, StreamFrame } from '@actionow/contracts';
import { renderAnthropicChat, renderAnthropicMessagesStream } from '@actionow/llm-protocol';
import type { Response } from 'express';

import { chatEventsOf, chatResponseOf } from './chat-ir-bridge.js';
import { statusForGatewayError } from './gateway-error.js';

/**
 * Render one sync chat GatewayResponse as an Anthropic Messages response.
 * `model` echoes the REQUESTED external name (the new world routes offerings,
 * never silently substitutes another model).
 */
export function renderAnthropicMessage(response: GatewayResponse): Record<string, unknown> {
  return renderAnthropicMessageOf(response.output, response.usage, response.model);
}

/** The Messages assembly, reusable for §5 idempotent replays (task-row output/usage). */
export function renderAnthropicMessageOf(
  output: unknown,
  usage: GatewayUsage | undefined,
  model: string,
): Record<string, unknown> {
  return renderAnthropicChat(chatResponseOf(output, usage), model);
}

/**
 * Render the IR StreamFrame sequence as Anthropic Messages SSE frames. A
 * mid-stream gateway `error` frame becomes the Anthropic `event: error` frame
 * and terminates the stream (the Anthropic wire has no [DONE] sentinel).
 */
export function renderAnthropicMessagesSse(
  frames: AsyncIterable<StreamFrame>,
  model: string,
): AsyncIterable<string> {
  return renderAnthropicMessagesStream(chatEventsOf(frames), model);
}

/** Frozen gateway taxonomy → the Anthropic wire error `type` string. */
export function anthropicErrorTypeOf(code: GatewayError['code']): string {
  switch (code) {
    case 'invalid_input':
    case 'unsupported_parameter':
    case 'conflict':
    case 'content_filtered':
      return 'invalid_request_error';
    case 'unauthorized':
      return 'authentication_error';
    case 'forbidden':
      return 'permission_error';
    case 'model_not_found':
    case 'task_not_found':
      return 'not_found_error';
    case 'insufficient_credits':
      return 'billing_error';
    case 'rate_limited':
      return 'rate_limit_error';
    case 'upstream_timeout':
      return 'timeout_error';
    case 'upstream_error':
      return 'overloaded_error';
    default:
      return 'api_error';
  }
}

/**
 * Write one gateway error in the Anthropic `{type:'error', error:{type,
 * message}}` envelope: HTTP status from the frozen taxonomy, Retry-After on
 * 429, the request id echoed on both `request-id` (the Anthropic wire header)
 * and `x-request-id` (platform convention).
 */
export function sendAnthropicError(res: Response, error: GatewayError, requestId: string): void {
  const status = statusForGatewayError(error.code);
  if (status === 429 && error.retryAfterMs !== undefined) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
  }
  res.setHeader('request-id', requestId);
  res.setHeader('x-request-id', requestId);
  res.status(status).json({
    type: 'error',
    error: { type: anthropicErrorTypeOf(error.code), message: error.message },
  });
}
