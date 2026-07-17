// apps/api/src/gateway/chat-dialect-facade.ts
//
// model-supply-greenfield 批次5 slice6 — the §4.1 LAYER-1 canonical 归一 for
// the NON-OpenAI chat sync surfaces: Anthropic `POST /v1/messages` and Gemini
// `POST /v1beta/models/{model}:generateContent[:streamGenerateContent]`, both
// mapping to operation `chat.completions`.
//
// Strategy (低成本裁决, task §A): REUSE the battle-tested llm-protocol wire
// parsers (`parseAnthropicChat` / `parseGeminiChat`, wire → the camelCase
// ChatRequest IR) and the `renderOpenAIRequest` inverse (IR → the OpenAI wire
// body) as the IR→canonical bridge — the OpenAI wire vocabulary IS the
// canonical snake_case vocabulary (chat-facade.ts), so the rendered body feeds
// the SAME `chatToGatewayRequest` profile machinery the OpenAI surface uses
// (isDefault marking, contract validation, alias 归一, envelope handling).
// Nothing is silently dropped on the way:
//
//   - reasoning knobs the parsers LIFT off the wire (anthropic
//     `output_config.effort` / `thinking.budget_tokens`, gemini
//     `thinkingConfig.thinkingLevel` / `.thinkingBudget`) are re-attached under
//     their canonical names: `reasoning_effort` (the OpenAI wire name) and
//     `reasoning_budget_tokens` (canonical-style snake_case — no OpenAI wire
//     equivalent exists; declaring/mapping it is contract-author business);
//   - every `ir.extra` leftover (anthropic top_k/metadata/service_tier…,
//     gemini safetySettings + the nested unrecognized generationConfig keys)
//     rides VERBATIM into the canonical body — undeclared-key fate is layer
//     2/contract authorship business, never a facade drop (chat-facade 范式).
//
// Pure functions, Result-typed, NO upstream I/O (红线: 门面只做第1层).
import type { ChatRequest } from '@actionow/contracts';
import {
  parseAnthropicChat,
  parseGeminiChat,
  ProtocolError,
  renderOpenAIRequest,
} from '@actionow/llm-protocol';

import type { OpenAIFacadeInput } from './chat-facade.js';
import { chatToGatewayRequest } from './chat-facade.js';
import type { FacadeResult } from './facade.js';

/**
 * Anthropic Messages body → the frozen GatewayRequest IR (§4.1 layer 1).
 * `system` is hoisted into a leading system-role message, `tool_use` /
 * `tool_result` blocks become OpenAI-shaped `tool_calls` / tool-role messages,
 * `stop_sequences`→`stop`, `max_tokens` stays canonical; `stream` comes from
 * the wire body (the Anthropic wire streams via `stream: true`).
 */
export function anthropicToGatewayRequest(input: OpenAIFacadeInput): FacadeResult {
  let ir: ChatRequest;
  try {
    ir = parseAnthropicChat(input.body);
  } catch (err) {
    if (err instanceof ProtocolError) return protocolFailure(err);
    throw err;
  }
  return fromChatIr(ir, input, input.body.stream === true);
}

/**
 * Gemini generateContent body → the frozen GatewayRequest IR (§4.1 layer 1).
 * The model arrives via the URL path (`input.modelName`), never the body;
 * `stream` comes from WHICH endpoint was hit (`:streamGenerateContent`), so it
 * is an explicit argument rather than a body key.
 */
export function geminiToGatewayRequest(input: OpenAIFacadeInput, stream: boolean): FacadeResult {
  let ir: ChatRequest;
  try {
    ir = parseGeminiChat(input.body, input.modelName);
  } catch (err) {
    if (err instanceof ProtocolError) return protocolFailure(err);
    throw err;
  }
  return fromChatIr(ir, input, stream);
}

// --- the IR→canonical bridge -----------------------------------------------------------

function fromChatIr(ir: ChatRequest, input: OpenAIFacadeInput, stream: boolean): FacadeResult {
  const canonical = renderOpenAIRequest(ir, input.modelName);

  // Reasoning knobs renderOpenAIRequest does not emit (it covers sampling +
  // response_format): re-attach under canonical names so nothing lifted off
  // the wire silently vanishes.
  if (ir.params?.reasoningEffort !== undefined) {
    canonical.reasoning_effort = ir.params.reasoningEffort;
  }
  if (ir.params?.reasoningBudgetTokens !== undefined) {
    canonical.reasoning_budget_tokens = ir.params.reasoningBudgetTokens;
  }

  // The parser's `extra` bag (unrecognized wire keys) rides verbatim — never
  // clobbering a structural key the bridge already produced.
  for (const [key, value] of Object.entries(ir.extra ?? {})) {
    if (!(key in canonical)) canonical[key] = value;
  }

  if (stream) canonical.stream = true;

  return chatToGatewayRequest({ ...input, body: canonical });
}

function protocolFailure(err: ProtocolError): FacadeResult {
  return {
    ok: false,
    error: { code: 'invalid_input', message: err.message, retryable: false, failover: false },
  };
}
