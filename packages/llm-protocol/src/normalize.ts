import type { ChatRequest } from '@actionow/contracts';

import type { ModelCapabilities } from './capabilities.js';
import { ProtocolError } from './errors.js';

/**
 * Gate an IR `ChatRequest` against a model's capabilities. Unsupported feature
 * → `ProtocolError('invalid_input', ...)` (the API renders a 400 per dialect).
 * Returns the request unchanged on success (a place to add downgrades later).
 */
export function normalizeRequest(req: ChatRequest, caps: ModelCapabilities): ChatRequest {
  if (req.tools !== undefined && req.tools.length > 0 && !caps.tools) {
    throw new ProtocolError('invalid_input', 'model does not support tools');
  }
  const wantsJson =
    req.params?.responseFormat === 'json_object' || req.params?.responseFormat === 'json_schema';
  if (wantsJson && !caps.json) {
    throw new ProtocolError('invalid_input', 'model does not support structured output');
  }
  for (const m of req.messages) {
    for (const part of m.content) {
      if (part.kind === 'image' && !caps.vision) {
        throw new ProtocolError('invalid_input', 'model does not support image input');
      }
      if (part.kind === 'audio' && !caps.audio) {
        throw new ProtocolError('invalid_input', 'model does not support audio input');
      }
    }
  }
  return req;
}
