// apps/api/src/gateway/chat-facade.ts
//
// model-supply-greenfield 批次5 slice3 — the §4.1 LAYER-1 canonical 归一 for
// the OpenAI-compatible SYNC surfaces (§5 OpenAI 兼容基座): `POST
// /v1/chat/completions` → operation `chat.completions`, `POST /v1/embeddings`
// → operation `embeddings`. The chat/embeddings twin of facade.ts's
// toGatewayRequest, with the OpenAI-wire specifics that layer owns:
//
//   - the OpenAI wire vocabulary IS the canonical snake_case vocabulary
//     (messages / temperature / top_p / max_tokens / stop / seed /
//     response_format / tools / tool_choice / …) — values are carried
//     STRUCTURALLY VERBATIM into `params` tagged `isDefault: false`;
//   - ALIASES are normalized to the canonical name here (§4.1 layer 1 名归一):
//     `max_completion_tokens` → `max_tokens`;
//   - the model contract (model.operations[op].params, §4) VALIDATES declared
//     params (type/domain via facade.ts checkCanonical) and contributes
//     canonical DEFAULTS for omitted ones, tagged `isDefault: true` — defaults
//     are NOT resolved further (offering semantics are the planner's, layer 2);
//   - UNDECLARED wire keys still ride into `params` (isDefault: false): the
//     OpenAI surface is a drop-in relay whose callers send fields the catalog
//     author may not have declared yet (penalties / n / user / logprobs …).
//     Their fate — filtering, mapping, forwarding — is layer 2/contract
//     authorship business, NEVER a silent facade drop;
//   - envelope/transport keys (`model`, `stream`, `stream_options`) become
//     {@link GatewayRequestOptions} / are rebuilt by adapter aspect ①, never
//     params.
//
// It does NO offering-declaration work and NO upstream I/O (红线: 门面只做
// 第1层). Pure functions, Result-typed — the caller maps errors to the wire.
import type {
  CanonicalParamValue,
  GatewayError,
  GatewayRequest,
  GatewayRequestOptions,
  ModelOperation,
  Operation,
} from '@actionow/contracts';

import type { FacadeAuth, FacadeResult } from './facade.js';
import { checkCanonical, fingerprintBody } from './facade.js';

// --- inputs -----------------------------------------------------------------------

/** One OpenAI-surface facade parse: raw wire body + contract + identity. */
export interface OpenAIFacadeInput {
  /** The model's EXTERNAL name (already resolved/visible — the caller's lookup). */
  modelName: string;
  /** The model's canonical contract FOR this operation (§4 挂模型). */
  contract: ModelOperation;
  /** The RAW OpenAI wire body (chat: unparsed; embeddings: `req.body`). */
  body: Record<string, unknown>;
  auth: FacadeAuth;
  idempotencyKey?: string | undefined;
  /** The X-Actionow-Route-Tag narrow-only pin (§8). */
  routeTag?: string | undefined;
}

// --- per-operation wire profiles ----------------------------------------------------

interface WireProfile {
  operation: Operation;
  /** Envelope/transport keys — never params. */
  envelopeKeys: ReadonlySet<string>;
  /** Wire alias → canonical param name (§4.1 layer-1 名归一). */
  aliases: Readonly<Record<string, string>>;
  /** The one wire key that must be present (and array-shaped when arrayRequired). */
  requiredKey: string;
  requiredIsArray: boolean;
  /** Streams allowed (chat yes; embeddings never). */
  streamable: boolean;
}

/**
 * `stream_options` is TRANSPORT framing (`include_usage` is forced by the
 * openai adapter's aspect ① on the stream fetch mode) — never a canonical
 * param. `model`/`stream` are the §5 envelope.
 */
const CHAT_PROFILE: WireProfile = {
  operation: 'chat.completions',
  envelopeKeys: new Set(['model', 'stream', 'stream_options']),
  aliases: { max_completion_tokens: 'max_tokens' },
  requiredKey: 'messages',
  requiredIsArray: true,
  streamable: true,
};

const EMBEDDINGS_PROFILE: WireProfile = {
  operation: 'embeddings',
  envelopeKeys: new Set(['model', 'stream']),
  aliases: {},
  requiredKey: 'input',
  requiredIsArray: false,
  streamable: false,
};

// --- the layer-1 canonical 归一 (OpenAI wire) -----------------------------------------

/** OpenAI chat body → the frozen {@link GatewayRequest} IR (§4.1 layer 1). */
export function chatToGatewayRequest(input: OpenAIFacadeInput): FacadeResult {
  return openaiToGatewayRequest(CHAT_PROFILE, input);
}

/** OpenAI embeddings body → the frozen {@link GatewayRequest} IR (§4.1 layer 1). */
export function embeddingsToGatewayRequest(input: OpenAIFacadeInput): FacadeResult {
  return openaiToGatewayRequest(EMBEDDINGS_PROFILE, input);
}

function openaiToGatewayRequest(profile: WireProfile, input: OpenAIFacadeInput): FacadeResult {
  const params: Record<string, CanonicalParamValue> = {};

  // 1. Alias-normalize the wire keys (canonical NAME 归一; values untouched).
  const normalized: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input.body)) {
    if (raw === undefined || profile.envelopeKeys.has(key)) continue;
    const canonicalName = profile.aliases[key] ?? key;
    if (canonicalName !== key && input.body[canonicalName] !== undefined) {
      // Both spellings present is an ambiguity the facade refuses to guess on.
      return invalid(`parameters '${key}' and '${canonicalName}' are aliases — send exactly one`, {
        param: canonicalName,
      });
    }
    normalized[canonicalName] = raw;
  }

  // 2. The operation's structural anchor (messages / input) is required even
  //    when the catalog contract is still the empty onboarding placeholder.
  const anchor = normalized[profile.requiredKey];
  if (anchor === undefined || (profile.requiredIsArray && !Array.isArray(anchor))) {
    return invalid(
      `openai ${profile.operation} request requires ${profile.requiredIsArray ? 'a' : ''} '${profile.requiredKey}'${profile.requiredIsArray ? ' array' : ''}`,
      { param: profile.requiredKey },
    );
  }

  // 3. Contract-declared params: validate explicit values, ride defaults along
  //    tagged isDefault (§4.1 layer 1 — NO offering semantics).
  const declared = new Map(input.contract.params.map((p) => [p.name, p]));
  for (const param of input.contract.params) {
    const raw = normalized[param.name];
    if (raw === undefined) {
      if (param.default !== undefined) {
        params[param.name] = { value: param.default, isDefault: true };
      } else if (param.required) {
        return invalid(`missing required parameter '${param.name}'`, { param: param.name });
      }
      continue;
    }
    const checked = checkCanonical(param, raw);
    if (!checked.ok) return checked;
    params[param.name] = { value: raw, isDefault: false };
  }

  // 4. Undeclared wire keys ride verbatim (drop-in surface; layer 2 owns their fate).
  for (const [name, raw] of Object.entries(normalized)) {
    if (!declared.has(name)) params[name] = { value: raw, isDefault: false };
  }

  const options: GatewayRequestOptions = {};
  if (profile.streamable && input.body.stream === true) options.stream = true;
  if (input.routeTag !== undefined) options.routeTag = input.routeTag;

  const request: GatewayRequest = {
    tenantId: input.auth.tenantId,
    apiKeyId: input.auth.apiKeyId,
    ...(input.auth.subjectId !== undefined ? { subjectId: input.auth.subjectId } : {}),
    operation: profile.operation,
    model: input.modelName,
    params,
    // Chat vision/audio inputs ride INSIDE `messages` verbatim (the OpenAI wire
    // is the canonical carrier); aspect-② extraction for chat is not a layer-1
    // duty on this surface.
    mediaRefs: [],
    options,
    ...(input.idempotencyKey !== undefined
      ? {
          idempotency: {
            key: input.idempotencyKey,
            bodyFingerprint: fingerprintBody(input.body),
          },
        }
      : {}),
  };
  return { ok: true, request };
}

// --- error helper -------------------------------------------------------------------

function invalid(
  message: string,
  details?: Record<string, unknown>,
): { ok: false; error: GatewayError } {
  return {
    ok: false,
    error: {
      code: 'invalid_input',
      message,
      retryable: false,
      failover: false,
      ...(details !== undefined ? { details } : {}),
    },
  };
}
