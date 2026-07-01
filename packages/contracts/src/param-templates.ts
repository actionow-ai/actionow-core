// packages/contracts/src/param-templates.ts
// NO zod here — a plain frozen constant, safe to import from browser (type-only) and engine alike.

/**
 * The reusable parameter-rule template library (Dify `PARAMETER_RULE_TEMPLATE`
 * equivalent). A `parameterRule` with `useTemplate: 'temperature'` inherits this
 * row; any field it also sets OVERRIDES the template (see `resolveRule`). The
 * shape is exactly the override-able subset of `parameterRuleSchema` (everything
 * except `name`/`useTemplate`). All numeric bounds are the OpenAI-canonical
 * ranges; adapters/`②` may clamp narrower per model×channel.
 */
export const PARAM_TEMPLATES = {
  temperature: {
    type: 'float',
    default: 1.0,
    min: 0,
    max: 2,
    help: 'Sampling temperature; higher = more random. 0 = greedy.',
  },
  top_p: {
    type: 'float',
    default: 1.0,
    min: 0,
    max: 1,
    help: 'Nucleus sampling: consider tokens with top_p cumulative probability.',
  },
  top_k: {
    type: 'int',
    min: 1,
    help: 'Sample only from the top-K most likely tokens (Anthropic/Gemini/Qwen).',
  },
  max_tokens: {
    type: 'int',
    default: 1024,
    min: 1,
    help: 'Maximum tokens to generate (maps to IR maxOutputTokens).',
  },
  response_format: {
    type: 'enum',
    options: ['text', 'json_object', 'json_schema'],
    default: 'text',
    help: 'Output structuring: free text, JSON object, or a strict JSON schema.',
  },
  reasoning_effort: {
    type: 'enum',
    options: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    default: 'medium',
    help: 'Reasoning/thinking effort; adapters map to the per-provider knob.',
  },
  stop: {
    type: 'json',
    help: 'Up to N stop sequences (string or string[]); generation halts on a match.',
  },
  seed: {
    type: 'int',
    help: 'Best-effort deterministic sampling seed.',
  },
  frequency_penalty: {
    type: 'float',
    default: 0,
    min: -2,
    max: 2,
    help: 'Penalize tokens by existing frequency; reduces verbatim repetition.',
  },
  presence_penalty: {
    type: 'float',
    default: 0,
    min: -2,
    max: 2,
    help: 'Penalize tokens already present; encourages new topics.',
  },
  logprobs: {
    type: 'boolean',
    default: false,
    help: 'Return per-token log probabilities.',
  },
} as const;

export type ParamTemplateName = keyof typeof PARAM_TEMPLATES;

/** Runtime guard: is a string a known template key (drives `useTemplate` validation + UI dropdown). */
export const PARAM_TEMPLATE_NAMES = Object.keys(PARAM_TEMPLATES) as ParamTemplateName[];
