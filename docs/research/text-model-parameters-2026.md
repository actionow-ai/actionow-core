<!-- Generated 2026-06-29 by a 10-vendor research workflow (official-docs fan-out) + a codebase pass-through audit.
     Parameter SHAPES/families are from vendor docs and reliable; bleeding-edge model NAMES/defaults
     should be spot-checked against live docs before hardcoding. -->

# Text-Model API Parameters Across Vendors, and Our Relay's Pass-Through Gap

## 1. Executive Answer

**No. Our backend does not forward all text-model parameters — and in particular, every reasoning / "thinking effort" control is dropped at the protocol layer, end-to-end.**

The relay is a **strict whitelist**, not a forward-all, and it enforces that whitelist at **three independent layers** so anything outside a canonical ~7-field set is silently discarded before it can ever reach an upstream provider:

1. **Hand-written dialect parsers (`parseParams()`)** in `packages/llm-protocol/src/{openai,anthropic,gemini}/parse.ts` read only a fixed list of wire keys and copy them into a small camelCase IR (`ChatParams`). Unknown wire fields are never even read.
2. **The IR contract schemas** `chatParamsSchema` / `chatRequestSchema` in `packages/contracts/src/chat.ts` are plain `z.object(...)` in zod's default `.strip()` mode — no `.passthrough()` / `.catchall()` anywhere on the chat schemas — so any key not in the schema is stripped.
3. **Each adapter's `buildChatBody()`** (`packages/adapters/src/{openai,anthropic}.ts`) **reconstructs a fresh provider body** from the IR's fixed fields. It never spreads the inbound request, so nothing extra can leak through to the upstream.

**The canonical supported set is exactly 7 chat params:** `temperature`, `topP`, `maxOutputTokens`, `stop`, `seed`, `responseFormat`, `jsonSchema` (`packages/contracts/src/chat.ts:64-73`).

**Reasoning effort status: NOT WIRED.** There is no `reasoning_effort`, `thinking`, `thinkingConfig`, or `thinkingBudget` field anywhere — not in the IR contract, not in any dialect parser, not in any adapter body builder. A grep across the entire repo (excluding `dist`) for `reasoning_effort|thinking|thinkingConfig|thinkingBudget|top_k|logprobs|logit_bias|frequency_penalty|presence_penalty` returns **zero matches** in the chat relay path. A client sending `{"reasoning_effort":"high"}` or `{"thinking":{...}}` has that key ignored by `parseParams` (never read), so it never enters the IR; the zod `.strip()` would drop it as a second line of defense regardless. **Reasoning models (OpenAI o-series / GPT-5.x, Claude extended thinking, Gemini thinking) cannot be controlled through this relay today.**

There are also two asymmetries even within the supported set: `seed` is forwarded **only** by the OpenAI adapter (Anthropic and Gemini drop it), and `responseFormat` / `jsonSchema` is **dropped by the Anthropic adapter** (it is in the IR but `anthropic.buildChatBody` ignores it; Anthropic's `capabilities.json=false` makes JSON requests 400 at normalize anyway).

---

## 2. Reasoning / "Thinking Effort" Family Across Vendors

This is the headline question: how does each vendor expose the "how hard should the model think" control, and what form does it take?

| Vendor | Param name | Form | Values | Models | Notes |
|---|---|---|---|---|---|
| **OpenAI** | `reasoning_effort` (Chat Completions) | enum string | `none \| minimal \| low \| medium \| high \| xhigh` (model-dependent) | Reasoning models only: o-series + GPT-5.x reasoning | Per-model defaults: gpt-5.5=`medium`, gpt-5.1=`none`; gpt-5-pro=`high`-only; gpt-5.2-pro=`medium/high/xhigh`; classic o-series=`low/medium/high`. `minimal` arrived w/ GPT-5; `xhigh` w/ gpt-5.1-codex-max. |
| **OpenAI** | `reasoning.effort` (Responses API) | object field (enum) | Same model-dependent enum | Reasoning models, Responses API | `reasoning:{effort, summary}`. Identical semantics to Chat `reasoning_effort`. |
| **OpenAI** | `reasoning.summary` (Responses) | enum string | `auto \| concise \| detailed` | Reasoning models, Responses | Natural-language summary of internal reasoning; default null. |
| **OpenAI** | `verbosity` / `text.verbosity` | enum string | `low \| medium \| high` (default `medium`) | GPT-5 / GPT-5.x | Companion output-length knob, NOT an effort control. |
| **Anthropic** | `thinking.type` | enum (in `thinking` object) | `adaptive \| enabled \| disabled` | adaptive: Fable 5/Mythos 5 (always-on), Opus 4.8/4.7 (only mode), Opus 4.6, Sonnet 4.6; enabled: all except Fable5/Mythos5/Opus4.8/4.7; disabled: all except 5-series | adaptive = Claude decides; enabled = manual budget; disabled = no thinking. |
| **Anthropic** | `thinking.budget_tokens` | token-budget int (only w/ `type:enabled`) | int ≥ 1024 and < `max_tokens` | Required on Opus 4.5/Sonnet 4.5 & earlier; deprecated on Opus 4.6/Sonnet 4.6; **400 on Opus 4.7/4.8, Fable 5, Mythos 5** | Legacy "reasoning budget"; gone on newest models. |
| **Anthropic** | `output_config.effort` | enum string (in `output_config`) | `low \| medium \| high \| xhigh \| max` | Fable 5, Mythos 5, Mythos Preview, Opus 4.8/4.7/4.6/4.5, Sonnet 4.6 (`xhigh` only on Fable5/Mythos5/Opus4.8/4.7) | **The modern reasoning-effort analog.** Default `high` (= omitting). Spans ALL output incl. tool calls. |
| **Anthropic** | `thinking.display` | enum (in `thinking` object) | `summarized \| omitted` | default `summarized` on Opus 4.6 & earlier; `omitted` on Fable5/Mythos5/Opus4.8/4.7/Mythos Preview | Whether returned thinking blocks contain readable text. Billing identical either way. |
| **Google (Gemini)** | `thinkingConfig.thinkingBudget` | token-budget int | int; `0`=disable, `-1`=dynamic; per-model ranges (2.5-pro 128–32768, 2.5-flash 0–24576, flash-lite 0/512–24576) | Gemini 2.5 series (pro/flash/flash-lite) | A maximum, not a requirement. 3.x: accepted only for back-compat — prefer `thinkingLevel`. |
| **Google (Gemini)** | `thinkingConfig.thinkingLevel` | enum string | `low \| medium \| high` (some expose only low/high) | **Gemini 3 series only** (3-pro/3.1-pro/3-flash/3.5-flash); NOT on 2.5 | Direct analog of OpenAI reasoning effort. **Mutually exclusive with `thinkingBudget` (400 if both).** Defaults: 3-pro/3.1-pro/3-flash=`high`, 3.5-flash=`medium`. |
| **Google (Gemini)** | `thinkingConfig.includeThoughts` | boolean | `true \| false` | Gemini 2.5 & 3 series | Returns summarized thought parts (`thought=true`). Interactions API spells this `thinking_summaries: auto\|none`. |
| **xAI (Grok)** | `reasoning_effort` (Chat Completions) | enum string | `none \| low \| medium \| high` (default `low`) | grok-4.3, grok-4.20-0309-reasoning | Original grok-4/grok-3 **error** if supplied; grok-3-mini accepted only `low/high`. |
| **xAI (Grok)** | `reasoning.effort` (Responses / multi-agent) | object field (enum) | `low \| medium \| high \| xhigh` | grok-4.20-multi-agent (xhigh only here); Responses API generally | **Special case:** for multi-agent, effort controls the NUMBER OF COLLABORATING AGENTS, not reasoning depth. |
| **DeepSeek** | `thinking` | object | `{type: enabled \| disabled}` (default `enabled`) | deepseek-v4-pro, deepseek-v4-flash | Master CoT on/off; produces separate `reasoning_content`. |
| **DeepSeek** | `reasoning_effort` | enum string | `high \| max` (compat: low/medium→high, xhigh→max) | thinking mode of v4-pro/flash | Default `high`; auto-bumped to `max` for some agent clients. Only high/max are real levels. |
| **DeepSeek** | `output_config.effort` | object (Anthropic-format) | `high \| max` | thinking mode of v4-pro/flash | Anthropic-format equivalent of `reasoning_effort`. |
| **Mistral** | `reasoning_effort` | enum string | API schema: `none \| minimal \| low \| medium \| high \| xhigh`; capability page documents only `high` and `none` | mistral-small-latest (Small 4), mistral-medium-3-5 | `high`=full thinking chunk before answer; `none`=minimal. Also on Agents/Conversations via `completion_args`. |
| **Mistral** | `prompt_mode` | enum string | `reasoning` (or null) | reasoning-capable models | Higher-level intent switch into thinking mode; interaction with `reasoning_effort` under-documented. |
| **Zhipu / GLM** | `thinking.type` | enum (in `thinking` object) | `enabled \| disabled` (default `enabled`) | GLM-4.5+ | enabled = think-capable models auto-decide; GLM-4.7 & GLM-4.5V think compulsorily. |
| **Zhipu / GLM** | `reasoning_effort` | enum string | `none, minimal, low, medium, high, xhigh, max` (default `max`) | **GLM-5.2 ONLY** | none/minimal→skip thinking; low/medium→high; xhigh→max. Only `high` and `max` practically distinct. |
| **Zhipu / GLM** | `thinking.clear_thinking` | boolean (in `thinking`) | `true \| false` (default `true`) | GLM-4.5+ | Preserved-Thinking lifecycle control, not an effort dial. |
| **Moonshot (Kimi)** | `thinking` | object `{type, keep}` | `type: enabled \| disabled`; `keep: all \| null` | kimi-k2.7-code/-highspeed, k2.6, k2.5 (NOT moonshot-v1) | **No effort enum, no token budget** — reasoning control is a boolean on/off plus a `keep` flag. k2.7-code is thinking-always-on (`disabled`→error). |
| **Cohere** | `thinking` | object | `{type: enabled \| disabled, token_budget?: positive int}` | command-a-reasoning-08-2025 (+ hybrid Command A family e.g. command-a-plus-05-2026) | **Bundles both the on/off flag AND the budget in one object.** Effort = budget size, not a low/med/high enum. Enabled by default on supporting models. |

---

## 3. Cross-Vendor Common Parameters

Exact wire name per vendor, or "—" if unsupported / not exposed on the native text-gen surface. (Gemini names are the fields inside `generationConfig` unless noted.)

| Param | OpenAI | Anthropic | Google (Gemini) | xAI (Grok) | DeepSeek | Mistral | Qwen/DashScope | Zhipu/GLM | Kimi | Cohere |
|---|---|---|---|---|---|---|---|---|---|---|
| temperature | `temperature` | `temperature` ¹ | `temperature` | `temperature` | `temperature` ² | `temperature` | `temperature` | `temperature` | `temperature` ³ | `temperature` |
| top_p | `top_p` | `top_p` ¹ | `topP` | `top_p` | `top_p` ² | `top_p` | `top_p` | `top_p` | `top_p` ³ | `p` |
| top_k | — | `top_k` ¹ | `topK` | — | — | — | `top_k` (native; via `extra_body` in compat) | — | — | `k` |
| max tokens | `max_completion_tokens` (legacy `max_tokens`); Responses `max_output_tokens` | `max_tokens` | `maxOutputTokens` | `max_completion_tokens` (legacy `max_tokens`) | `max_tokens` | `max_tokens` | `max_tokens` / `max_completion_tokens` | `max_tokens` | `max_completion_tokens` (alias `max_tokens`) | `max_tokens` |
| frequency_penalty | `frequency_penalty` | — | `frequencyPenalty` | `frequency_penalty` ⁴ | DEPRECATED (no-op) | `frequency_penalty` | `frequency_penalty` (model-dependent) | — ⁵ | `frequency_penalty` | `frequency_penalty` ⁶ |
| presence_penalty | `presence_penalty` | — | `presencePenalty` | `presence_penalty` ⁴ | DEPRECATED (no-op) | `presence_penalty` | `presence_penalty` | — ⁵ | `presence_penalty` | `presence_penalty` ⁶ |
| stop | `stop` ⁴ | `stop_sequences` | `stopSequences` | `stop` ⁴ | `stop` | `stop` | `stop` | `stop` | `stop` | `stop_sequences` |
| seed | `seed` (beta) | — | `seed` | `seed` | — | `random_seed` | `seed` | — | — ⁷ | `seed` |
| n | `n` | — | `candidateCount` | `n` | — | `n` | `n` (1–4, non-thinking) | — ⁵ | `n` (1–5) | — |
| logprobs | `logprobs` / `top_logprobs` ⁴ | — | `responseLogprobs` / `logprobs` | `logprobs` / `top_logprobs` | `logprobs` / `top_logprobs` ⁸ | — | `logprobs` / `top_logprobs` | — | — ⁷ | `logprobs` (bool) |
| response_format | `response_format` (Responses `text.format`) | `output_config.format` (structured) | `responseMimeType` + `responseSchema`/`responseJsonSchema` | `response_format` | `response_format` (text/json_object) | `response_format` | `response_format` | `response_format` (text/json_object) | `response_format` | `response_format` |
| tools / tool_choice | `tools` / `tool_choice` | `tools` / `tool_choice` | `tools` / `toolConfig` | `tools` / `tool_choice` | `tools` / `tool_choice` | `tools` / `tool_choice` | `tools` / `tool_choice` | `tools` / `tool_choice` (only `auto`) | `tools` / `tool_choice` (no `required`) | `tools` / `tool_choice` (REQUIRED/NONE) |
| stream | `stream` | `stream` | (`:streamGenerateContent` endpoint) | `stream` | `stream` | `stream` | `stream` | `stream` | `stream` | `stream` |
| logit_bias | `logit_bias` ⁴ | — | — | `logit_bias` | — | — | — | — | — ⁷ | — |

**Footnotes**
¹ Anthropic: `temperature`, `top_p`, `top_k` are **rejected with 400 on Opus 4.7+ (incl. 4.8)**; supported on Opus 4.5/4.1, Sonnet 4.5, Haiku 4.5 and earlier. With thinking enabled, `top_p` is restricted to 0.95–1.0 and others are incompatible.
² DeepSeek: `temperature`/`top_p` are **silently ignored in thinking mode** (no error); effective only in non-thinking mode.
³ Kimi: `temperature`/`top_p`/`n` are **user-tunable only on moonshot-v1**; on k2.5/k2.6 they are fixed by thinking mode (thinking-on → temp 1.0/top_p 0.95/n 1).
⁴ OpenAI & xAI reasoning models **reject** `temperature`, `top_p`, `presence_penalty`, `frequency_penalty`, `stop`, `logprobs`, `logit_bias` (model-dependent; the single biggest routing gotcha).
⁵ GLM: `frequency_penalty`/`presence_penalty`/`n` not in first-party docs — possibly accepted via OpenAI-compat but unverified.
⁶ Cohere penalties clamped **0.0–1.0** (narrower than OpenAI's −2..2).
⁷ Kimi: `logprobs`/`top_logprobs`/`seed`/`logit_bias` not listed in the reference — assume unsupported.
⁸ DeepSeek: `logprobs`/`top_logprobs` **error in thinking mode**; valid only non-thinking.

---

## 4. Per-Vendor Full Parameter List

### 4.1 OpenAI

- **API style:** Two first-party surfaces — Chat Completions (`POST /v1/chat/completions`, legacy/compat) and Responses (`POST /v1/responses`, current recommended superset). Old text Completions (`/v1/completions`) is legacy. Third-party OpenAI-compatible servers almost always implement `/v1/chat/completions`.
- **Latest models:** gpt-5.5 (snapshot gpt-5.5-2026-04-23; default `reasoning_effort=medium`, supports none/low/medium/high/xhigh), gpt-5.5-pro (high-only), gpt-5.4 / gpt-5.4-mini / gpt-5.4-nano, gpt-5.2 / gpt-5.2-pro (medium/high/xhigh), gpt-5.1 (defaults to none) / gpt-5.1-codex-max (adds xhigh), gpt-5 / gpt-5-mini / gpt-5-nano / gpt-5-pro (high-only), o3 / o3-pro / o4-mini / o1 (low/medium/high), gpt-4.1 / gpt-4.1-mini / gpt-4.1-nano (non-reasoning), gpt-4o / gpt-4o-mini (non-reasoning multimodal).
- **Docs:** [chat](https://platform.openai.com/docs/api-reference/chat) · [chat create](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) · [responses create](https://developers.openai.com/api/reference/resources/responses/methods/create) · [migrate-to-responses](https://developers.openai.com/api/docs/guides/migrate-to-responses) · [reasoning](https://developers.openai.com/api/docs/guides/reasoning) · [latest-model](https://developers.openai.com/api/docs/guides/latest-model) · [gpt-5 new params](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_new_params_and_tools) · [gpt-5.5](https://developers.openai.com/api/docs/models/gpt-5.5) · [all models](https://developers.openai.com/api/docs/models/all) · [response length](https://help.openai.com/en/articles/5072518-controlling-the-length-of-openai-model-responses)

| Name | Type | Values | Applies to | Category | Description |
|---|---|---|---|---|---|
| model | string | any current model ID | All (required) | routing | Model ID used to generate the response. |
| messages | array | role-tagged message objects (developer/system/user/assistant/tool/function); text/image/audio/file parts | Chat Completions (required) | other | Conversation history. |
| input | string or array | string \| array of Items | Responses (required) | other | Responses equivalent of messages. |
| instructions | string | string | Responses | other | Top-level system/developer instruction. |
| temperature | number | 0–2 (default 1) | Non-reasoning models | sampling | Sampling temperature. NOT on reasoning models. |
| top_p | number | 0–1 (default 1) | Non-reasoning models | sampling | Nucleus sampling. NOT on reasoning models. |
| max_tokens | int or null | positive int | Chat Completions; DEPRECATED; not reasoning | length | Legacy generated-token cap; doesn't count reasoning tokens. |
| max_completion_tokens | int or null | positive int | Chat Completions (all incl. reasoning) | length | Upper bound incl. visible output AND reasoning tokens. |
| max_output_tokens | int or null | positive int | Responses | length | Total generated tokens (output + reasoning). |
| max_tool_calls | int or null | positive int | Responses | tools | Max total built-in tool calls. |
| frequency_penalty | number | −2.0 to 2.0 (default 0) | Non-reasoning | penalty | Proportional repeat penalty. NOT on reasoning. |
| presence_penalty | number | −2.0 to 2.0 (default 0) | Non-reasoning | penalty | One-off appearance penalty. NOT on reasoning. |
| stop | string/array/null | up to 4 strings | Chat Completions (non-reasoning) | length | Stop sequences. NOT on latest reasoning models; no top-level Responses equivalent. |
| n | int or null | ≥1 (default 1) | Chat Completions only | output-format | Number of choices. |
| logit_bias | object/null | token-id → [−100,100] | Chat Completions (non-reasoning) | sampling | Additive logit bias; no Responses equivalent. |
| logprobs | bool or null | true/false (default false) | Chat Completions (non-reasoning); Responses via `include[]` | output-format | Return token log-probs. NOT on reasoning. |
| top_logprobs | int or null | 0–20 | Chat Completions (needs logprobs=true) & Responses | output-format | Most-likely tokens per position. NOT on reasoning. |
| seed | int or null | integer | Chat Completions (beta) | sampling | Best-effort deterministic sampling; watch system_fingerprint. |
| response_format | object | type: text/json_object/json_schema | Chat Completions | output-format | Output-format selector; Structured Outputs. |
| text | object | {format, verbosity} | Responses | output-format | Output-text config object. |
| text.format | object | type: text/json_object/json_schema | Responses | output-format | Responses equivalent of response_format. |
| text.verbosity | string | low/medium/high (default medium) | GPT-5/5.x | output-format | Reply expansiveness. |
| verbosity | string | low/medium/high (default medium) | GPT-5/5.x Chat Completions | output-format | Top-level verbosity hint. |
| reasoning_effort | string | none/minimal/low/medium/high/xhigh (model-dep) | Reasoning models, Chat Completions | reasoning | Reasoning-token spend control. |
| reasoning | object | {effort, summary: auto/concise/detailed} | Reasoning models, Responses | reasoning | Responses reasoning config. |
| tools | array | function/custom/web_search/file_search/code_interpreter/image_generation/computer_use_preview/mcp… | All (hosted tools Responses-only) | tools | Tools the model may call; GPT-5 custom (freeform/grammar) tools. |
| tool_choice | string/object | none/auto/required/{function}/{custom}/hosted selectors | All | tools | Whether/which tool is called. |
| parallel_tool_calls | bool | true/false (default true) | All (false-forced w/ custom freeform) | tools | Allow multiple tool calls per turn. |
| functions | array | function defs | Chat Completions; DEPRECATED | tools | Legacy function-calling list. |
| function_call | string/object | none/auto/{name} | Chat Completions; DEPRECATED | tools | Legacy tool_choice for functions. |
| stream | bool | true/false (default false) | All | streaming | SSE streaming. |
| stream_options | object/null | {include_usage, (Responses) include_obfuscation} | All (stream=true) | streaming | Streaming options; include_usage emits final usage chunk. |
| store | bool | true/false | All (Chat default false, Responses default true) | caching | Persist output (evals/distillation; previous_response_id chaining). |
| metadata | object/null | ≤16 pairs; keys ≤64, values ≤512 | All | other | Key-value tags for later filtering. |
| service_tier | string/null | auto/default/flex/priority (default auto) | All | routing | Processing tier (latency/cost SLA). |
| user | string | string | All; legacy | safety | End-user identifier (being superseded). |
| safety_identifier | string | string | All | safety | Hashed end-user ID for safety systems. |
| prompt_cache_key | string | string | All | caching | Cache-routing key. |
| prediction | object/null | {type:content, content} | Chat Completions on supported (gpt-4o family); not reasoning | output-format | Predicted Outputs to speed regeneration. |
| modalities | array/null | ['text'] \| ['text','audio'] | Chat Completions audio models | output-format | Output modalities. |
| audio | object/null | {voice, format} | Chat Completions audio models | output-format | Audio output config (required w/ audio modality). |
| web_search_options | object/null | {search_context_size, user_location} | Chat Completions search-preview models | tools | Built-in web search config. |
| previous_response_id | string/null | response id | Responses | caching | Chain to a prior stored response. |
| conversation | string/object/null | id \| object | Responses | other | Persistent server-side Conversation. |
| include | array/null | message.output_text.logprobs / reasoning.encrypted_content / *_call.results / *.outputs / computer_call_output.output.image_url | Responses | output-format | Request extra response data. |
| background | bool/null | true/false (default false) | Responses | routing | Run asynchronously. |
| truncation | string | auto/disabled (default disabled) | Responses | length | Over-context strategy. |
| prompt | object/null | {id, version, variables} | Responses | other | Stored/managed Prompt template. |
| context_management | object/null | {type, compact_threshold,…} | Responses (newer; verify) | length | Automatic context compaction. |

### 4.2 Anthropic (Claude)

- **API style:** Native Messages API — `POST https://api.anthropic.com/v1/messages` (SSE via `stream:true`; batch via `/v1/messages/batches`). NOT OpenAI-compatible — role/content blocks, `x-api-key` + `anthropic-version` headers. A separate OpenAI-compat shim exists.
- **Latest models:** claude-fable-5 (thinking always-on), claude-mythos-5 (always-on), claude-mythos-preview (adaptive default), claude-opus-4-8 (adaptive-only), claude-opus-4-7 (adaptive-only), claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5(-20251001), claude-opus-4-5(-20251101), claude-sonnet-4-5(-20250929), claude-opus-4-1(-20250805).
- **Docs:** [messages](https://platform.claude.com/docs/en/api/messages) · [adaptive-thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking) · [effort](https://platform.claude.com/docs/en/build-with-claude/effort) · [migration-guide](https://platform.claude.com/docs/en/about-claude/models/migration-guide) · [whats-new-4-8](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-8) · [whats-new-4-7](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7)

| Name | Type | Values | Applies to | Category | Description |
|---|---|---|---|---|---|
| model | string (enum) | claude-fable-5, claude-mythos-5, claude-mythos-preview, claude-opus-4-8/4-7/4-6, claude-sonnet-4-6, claude-haiku-4-5(-20251001), claude-opus-4-5(-20251101), claude-sonnet-4-5(-20250929), claude-opus-4-1(-20250805) | all (required) | routing | The Claude model to use. |
| messages | array of MessageParam | role + content (text/image/document/tool_use/tool_result/thinking/redacted_thinking) | all (required) | other | Ordered turns; stateless. Trailing-assistant prefill rejected (400) on Fable5/Mythos5/Mythos Preview/Opus4.8/4.7/4.6/Sonnet4.6. |
| max_tokens | int (≥0) | ≥0; model-dependent max; 0 populates cache; incl. thinking tokens; batch up to 300k on Opus4.6/Sonnet4.6 w/ beta header | all (required) | length | Hard cap on generated tokens (thinking + visible). |
| system | string OR array of TextBlockParam | string, or array of {type:text, text, cache_control?/citations?} | all | other | System prompt; supports prompt-caching blocks. |
| temperature | number | 0.0–1.0 (default 1.0) | Opus4.5/4.1, Sonnet4.5, Haiku4.5 & earlier; **400 on Opus4.7/4.8+** | sampling | Sampling randomness. Cannot combine w/ extended thinking. |
| top_p | number | 0.0–1.0 (w/ thinking only 0.95–1.0) | same restriction; 400 on Opus4.7/4.8+ | sampling | Nucleus sampling. Use temp OR top_p. |
| top_k | int | positive int (default disabled) | same restriction; 400 on Opus4.7/4.8+ | sampling | Top-K candidate restriction; incompatible w/ thinking. |
| stop_sequences | array of string | custom strings | all | length | Custom stop sequences (returns stop_reason=stop_sequence). |
| stream | bool | true/false (default false) | all | streaming | Stream as SSE. |
| tools | array of ToolUnion | custom {name, description, input_schema} + built-in: bash, code_execution, text_editor, web_search, web_fetch, memory, tool_search_tool | all (built-in varies by model/beta) | tools | Tool/function definitions. |
| tool_choice | object | {auto}/{any}/{none}/{tool, name} + disable_parallel_tool_use? | all; forced use incompatible w/ thinking | tools | Whether/which tool must be called. |
| metadata | object | {user_id?} | all | other | Opaque request metadata (no PII). |
| service_tier | string | auto / standard_only (default auto) | all | routing | Priority/scale vs standard capacity. |
| thinking | object (ThinkingConfigParam) | {type:adaptive, display?} / {type:enabled, budget_tokens, display?} / {type:disabled}; display ∈ summarized/omitted | model-specific (see §2) | reasoning | Extended/adaptive thinking config. |
| output_config | object (OutputConfig) | {effort?: low/medium/high/xhigh/max, format?: JSONOutputFormat} | effort on Fable5/Mythos5/Mythos Preview/Opus4.8/4.7/4.6/4.5/Sonnet4.6 | reasoning | Output controls: effort (token-spend across all output) + structured format. |
| container | string | container id from prior request | code-execution/tool models | tools | Reuse a prior tool container. |
| mcp_servers | array | MCP connector definitions (beta) | all (beta) | tools | Remote MCP server connectors. |
| context_management | object | context-editing/retention config (e.g. thinking-block retention) | models supporting context editing | other | Automatic context editing/retention. |
| cache_control (top-level) | object | {type:ephemeral, ttl?: 5m/1h} | all | caching | Ephemeral prompt caching (also per-block). |
| inference_geo | string | region code | all (data-residency) | routing | Pin inference to a region. |
| anthropic-version (header) | string | e.g. 2023-06-01 (required) | all | routing | API version pin. |
| x-api-key (header) | string | your API key (required) | all | safety | Authentication. |
| content-type (header) | string | application/json (required) | all | other | Request body content type. |
| anthropic-beta (header) | string (CSV) | interleaved-thinking-2025-05-14, output-300k-2026-03-24, fine-grained-tool-streaming, MCP-connector flag… | all | other | Opt into beta features. |

### 4.3 Google (Gemini API — generativelanguage.googleapis.com)

- **API style:** Native Gemini REST — `POST /v1beta/models/{model}:generateContent` (`:streamGenerateContent` for SSE), `x-goog-api-key` header. A separate OpenAI-compat shim (`/v1beta/openai/chat/completions`) exists; the new agentic Interactions API (`/v1/.../interactions`) is positioned as successor — `generateContent` labeled "legacy" but fully supported.
- **Latest models:** gemini-3-pro-preview (low/high thinking), gemini-3.1-pro-preview, gemini-3-flash-preview, gemini-3.5-flash, gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite, gemini-2.0-flash, gemini-2.0-flash-lite.
- **Docs:** [generate-content](https://ai.google.dev/api/generate-content) · [api](https://ai.google.dev/api) · [text-generation](https://ai.google.dev/gemini-api/docs/text-generation) · [thinking (generate-content)](https://ai.google.dev/gemini-api/docs/generate-content/thinking) · [thinking](https://ai.google.dev/gemini-api/docs/thinking) · [all-methods](https://ai.google.dev/api/all-methods)

| Name | Type | Values | Applies to | Category | Description |
|---|---|---|---|---|---|
| contents | Content[] | array of {role, parts[]} (text/inlineData/fileData/functionCall/functionResponse) | all (required) | other | Conversation turns. |
| systemInstruction | Content | text parts | all current (1.5+/2.x/3.x) | other | Developer system instruction. |
| tools | Tool[] | functionDeclarations, googleSearch/googleSearchRetrieval, codeExecution, urlContext | all (built-ins model-dep) | tools | Tools the model may call. |
| toolConfig | ToolConfig | {functionCallingConfig:{mode, allowedFunctionNames[]}} | function-calling models | tools | How tools are invoked. |
| toolConfig.functionCallingConfig.mode | enum | AUTO / ANY / NONE / MODE_UNSPECIFIED (default AUTO) | function-calling models | tools | Whether/how function calls emit. |
| safetySettings | SafetySetting[] | array of {category, threshold} | all | safety | Per-category block thresholds. |
| safetySettings[].category | enum (HarmCategory) | HARASSMENT / HATE_SPEECH / SEXUALLY_EXPLICIT / DANGEROUS_CONTENT / CIVIC_INTEGRITY | all | safety | Harm category. |
| safetySettings[].threshold | enum (HarmBlockThreshold) | BLOCK_NONE / BLOCK_ONLY_HIGH / BLOCK_MEDIUM_AND_ABOVE / BLOCK_LOW_AND_ABOVE / OFF / UNSPECIFIED | all | safety | Block-probability level. |
| cachedContent | string | cachedContents/{id} | context-caching models (1.5+/2.x) | caching | Prepend explicit context cache. |
| serviceTier | enum (ServiceTier) | ServiceTier enum | newer models; tier-dependent | routing | Service tier. |
| store | bool | true/false | newer models | other | Per-request logging override. |
| labels | map<string,string> | key/value | Vertex/newer surfaces | other | User-defined metadata labels. |
| generationConfig | GenerationConfig | container object | all | other | Container for generation/decoding/output-format options. |
| generationConfig.temperature | float | 0.0–2.0 (model-dep) | all | sampling | Sampling randomness. |
| generationConfig.topP | float | 0.0–1.0 (commonly 0.95) | all | sampling | Nucleus sampling. |
| generationConfig.topK | integer | positive int (model-dep) | models exposing top-K | sampling | Top-K sampling. |
| generationConfig.candidateCount | integer | positive int (often capped 1, default 1) | all (multi-candidate varies) | output-format | Number of candidates. |
| generationConfig.maxOutputTokens | integer | up to model output limit | all | length | Max generated tokens per candidate. |
| generationConfig.stopSequences | string[] | array (max ~5) | all | length | Stop sequences (excluded from output). |
| generationConfig.responseMimeType | string | text/plain / application/json / text/x.enum (default text/plain) | all (JSON/enum 1.5+) | output-format | MIME type of returned text. |
| generationConfig.responseSchema | Schema | OpenAPI-subset Schema | structured-output models | output-format | Constrains structured output (needs JSON mime). |
| generationConfig.responseJsonSchema | JsonSchema | standard JSON Schema | newer (2.x/3.x) | output-format | Alternative structured-output schema. |
| generationConfig.responseModalities | enum[] (Modality) | TEXT / IMAGE / AUDIO (default [TEXT]) | TEXT all; IMAGE/AUDIO on capable models | output-format | Output modalities. |
| generationConfig.seed | integer | integer | 2.x/3.x (varies) | sampling | Best-effort reproducible sampling. |
| generationConfig.presencePenalty | float | ~−2.0 to 2.0 (default 0) | 2.x/3.x | penalty | Penalize already-seen tokens. |
| generationConfig.frequencyPenalty | float | ~−2.0 to 2.0 (default 0) | 2.x/3.x | penalty | Frequency-proportional penalty. |
| generationConfig.responseLogprobs | bool | true/false (default false) | logprobs-capable models | output-format | Return chosen-token log-probs. |
| generationConfig.logprobs | integer | small non-neg (≤~5) | logprobs-capable | output-format | Top candidate logprobs per step. |
| generationConfig.enableEnhancedCivicAnswers | bool | true/false (default false) | select models | safety | Enhanced civic/elections answers. |
| generationConfig.mediaResolution | enum (MediaResolution) | UNSPECIFIED / LOW / MEDIUM / HIGH | multimodal-input (2.x/3.x) | other | Token cost/detail of input media. |
| generationConfig.speechConfig | SpeechConfig | voiceConfig.prebuiltVoiceConfig.voiceName, languageCode, multi-speaker | TTS/audio-output models | output-format | Voice/speech settings. |
| generationConfig.audioTimestamp | bool | true/false (default false) | audio-input models | output-format | Timestamp understanding for audio input. |
| generationConfig.thinkingConfig | ThinkingConfig | {thinkingBudget, includeThoughts, thinkingLevel} | Gemini 2.5 & 3 series | reasoning | Reasoning controls (see §2). |

### 4.4 xAI (Grok)

- **API style:** OpenAI-compatible `POST /v1/chat/completions` at `https://api.x.ai/v1` (drop-in OpenAI SDK; Bearer auth). Also a native Responses API (`POST /v1/responses`: input, store, include, previous_response_id, reasoning.effort) — chat-completions guide labeled legacy but fully supported.
- **Latest models:** grok-4.3 (flagship; 1M ctx; reasoning none/low/medium/high), grok-4.20-0309-reasoning, grok-4.20-0309-non-reasoning, grok-4.20-multi-agent-0309 (reasoning.effort controls agent count, adds xhigh), grok-build-0.1 (256k; coding).
- **Docs:** [api-reference](https://docs.x.ai/docs/api-reference) · [chat](https://docs.x.ai/docs/guides/chat) · [reasoning](https://docs.x.ai/docs/guides/reasoning) · [models](https://docs.x.ai/developers/models) · [structured-outputs](https://docs.x.ai/docs/guides/structured-outputs) · [live-search](https://docs.x.ai/docs/guides/live-search)

| Name | Type | Values | Applies to | Category | Description |
|---|---|---|---|---|---|
| model | string | any valid model ID | all (required) | routing | Model identifier. |
| messages | array<object> | role + content; text/document/image/audio (model-dep) | all (required) | other | Chat conversation. |
| frequency_penalty | number/null | −2.0 to 2.0 (default null) | non-reasoning only — reasoning models error | penalty | Frequency-based penalty. |
| presence_penalty | number/null | −2.0 to 2.0 (default null) | non-reasoning only — reasoning models error | penalty | Presence-based penalty. |
| logit_bias | object/null | −100 to 100 per token (default null) | all (sampling models) | sampling | Per-token logit bias. |
| logprobs | bool/null | true/false (default null/false) | all | output-format | Return output-token log-probs. |
| top_logprobs | int/null | 0–8 (default null) | all (needs logprobs=true) | output-format | Most-likely tokens per position. |
| max_tokens | int/null | positive int | all (DEPRECATED) | length | [Deprecated] generated-token cap. |
| max_completion_tokens | int/null | positive int | all | length | Output + reasoning tokens cap. |
| n | int/null | positive int (default 1) | all | output-format | Number of choices. |
| response_format | object | type: text/json_object/json_schema (json_schema: name, schema, strict default true) | all | output-format | Output format spec. |
| seed | int/null | integer (default null) | all | sampling | Best-effort determinism. |
| stop | array/null | up to 4 strings | non-reasoning only — reasoning models error | length | Stop sequences. |
| stream | bool/null | true/false (default null/false) | all | streaming | SSE streaming. |
| stream_options | object | {include_usage} (default null) | all (stream=true) | streaming | Final usage chunk. |
| temperature | number/null | 0–2 (default null) | all | sampling | Sampling temperature. |
| top_p | number/null | 0–1 (default null) | all | sampling | Nucleus sampling. |
| tools | array/null | function tools {name, description, parameters} (default null) | all | tools | Tools the model may call; strict schema conformance. |
| tool_choice | string/object | none/auto/required/{function} (default null) | all | tools | Tool invocation control. |
| parallel_tool_calls | bool/null | true/false (default null/true) | all | tools | Allow ≤1 tool call when false. |
| user | string/null | string (default null) | all | safety | End-user identifier. |
| reasoning_effort | string/null | none/low/medium/high (default low) | reasoning models only; grok-4/grok-3 error; grok-3-mini low/high | reasoning | Thinking-effort control. |
| search_parameters | object | {mode (off/auto/on), return_citations, from_date, to_date, max_search_results, sources[{type: web/x/news/rss}]} | all (legacy Live Search) | tools | Real-time data search config. |
| web_search_options | object | object (allowed_domains/excluded_domains/enable_image_understanding/enable_image_search) | search-capable (grok-4.3) | tools | OpenAI-compat web-search options. |
| deferred | bool/null | true/false (default null/false) | all | routing | Async retrieval via request_id. |
| prompt_cache_key | string/null | string (default null) | all | caching | Prompt-cache routing key. |

### 4.5 DeepSeek

- **API style:** OpenAI-compatible. Primary `POST https://api.deepseek.com/chat/completions` (`/v1` suffix also accepted). Plus Beta FIM `POST .../beta/completions` (legacy text-completion schema). Bearer auth, stateless. `reasoning_effort` accepts both OpenAI form and Anthropic `output_config.effort` form.
- **Latest models:** deepseek-v4-pro (1M ctx, max output 384K; thinking default-on; reasoning_effort high/max), deepseek-v4-flash (same), deepseek-chat (DEPRECATED alias = non-thinking v4-flash; EOL 2026/07/24), deepseek-reasoner (DEPRECATED alias = thinking v4-flash; EOL 2026/07/24).
- **Docs:** [create-chat-completion](https://api-docs.deepseek.com/api/create-chat-completion) · [thinking_mode](https://api-docs.deepseek.com/guides/thinking_mode) · [reasoning_model](https://api-docs.deepseek.com/guides/reasoning_model) · [create-completion](https://api-docs.deepseek.com/api/create-completion) · [fim_completion](https://api-docs.deepseek.com/guides/fim_completion) · [chat_prefix_completion](https://api-docs.deepseek.com/guides/chat_prefix_completion) · [pricing](https://api-docs.deepseek.com/quick_start/pricing) · [parameter_settings](https://api-docs.deepseek.com/quick_start/parameter_settings)

| Name | Type | Values | Applies to | Category | Description |
|---|---|---|---|---|---|
| model | string | deepseek-v4-flash, deepseek-v4-pro (legacy deepseek-chat/reasoner till 2026/07/24) | all (required) | routing | Model ID. |
| messages | object[] (min 1) | array of message objects | all (required) | other | Conversation history. |
| messages[].role | string | system/user/assistant/tool | all | other | Author role. |
| messages[].content | string/null | text (null for assistant tool-call msgs) | all | other | Message contents. |
| messages[].name | string | any | all | other | Differentiate same-role participants. |
| messages[].prefix | bool | true/false (default false) | Beta (/beta base) | output-format | Force assistant answer to begin with given content. |
| messages[].reasoning_content | string (nullable) | any | thinking models (Beta, w/ prefix) | reasoning | Pre-filled CoT input for thinking mode. |
| messages[].tool_call_id | string | id from prior tool_call | all (role=tool) | tools | The tool call being responded to. |
| thinking | object (nullable) | {type: enabled/disabled} (default enabled) | deepseek-v4-pro/flash | reasoning | Toggle thinking vs non-thinking. |
| thinking.type | string | enabled/disabled (default enabled) | deepseek-v4-pro/flash | reasoning | enabled = thinking mode. |
| reasoning_effort | string | high/max (compat low/medium→high, xhigh→max; default high) | thinking mode (v4-pro/flash) | reasoning | Reasoning depth. |
| output_config.effort | string (object field) | high/max (default high) | thinking mode | reasoning | Anthropic-format equivalent. |
| max_tokens | int (nullable) | positive int; incl. CoT in thinking mode (legacy reasoner default 32K/max 64K) | all | length | Max generated tokens. |
| response_format | object (nullable) | {type: text/json_object} (default text) | all | output-format | JSON Output. |
| response_format.type | string | text/json_object (default text) | all | output-format | Output mode. |
| stop | string/string[] (nullable) | up to 16 sequences (default null) | all | length | Stop sequences. |
| stream | bool (nullable) | true/false (default false) | all | streaming | SSE deltas, terminated by [DONE]. |
| stream_options | object (nullable) | {include_usage} (default null) | all (stream=true) | streaming | Streaming options. |
| stream_options.include_usage | bool | true/false (default false) | all (stream=true) | streaming | Extra usage chunk before [DONE]. |
| temperature | number (nullable) | 0–2 (default 1) | non-thinking only; ignored (no error) in thinking | sampling | Sampling temperature; per-use-case recs (coding 0.0…creative 1.5). |
| top_p | number (nullable) | 0–1 (default 1) | non-thinking only; ignored in thinking | sampling | Nucleus sampling. |
| frequency_penalty | number (nullable) | DEPRECATED (no-op) | all | penalty | No longer supported. |
| presence_penalty | number (nullable) | DEPRECATED (no-op) | all | penalty | No longer supported. |
| tools | object[] (nullable) | up to 128 functions (default null) | all | tools | Tools the model may call (functions only). |
| tools[].type | string | function | all | tools | Tool type (only function). |
| tools[].function | object | {name (^[a-zA-Z0-9_-]{1,64}$), description, parameters, strict (default false)} | all | tools | Function definition. |
| tool_choice | string/object (nullable) | none/auto/required/{function} (default auto) | all | tools | Tool-call control. |
| logprobs | bool (nullable) | true/false (default false) | non-thinking; ERRORS in thinking | output-format | Return token log-probs. |
| top_logprobs | int (nullable) | 0–20 (default null) | non-thinking (needs logprobs=true); ERRORS in thinking | output-format | Most-likely tokens per position. |
| user_id | string (nullable) | [a-zA-Z0-9-_], max 512 | all | safety | End-user identifier (no PII). |
| prompt (FIM /beta) | string | any (default "Once upon a time,") | FIM Beta endpoint | other | Prefix text to complete from. |
| suffix (FIM /beta) | string | any text | FIM Beta endpoint | other | Text after the insertion. |
| echo (FIM /beta) | bool | true/false (default false) | FIM Beta endpoint | output-format | Echo prompt with completion. |
| logprobs (FIM /beta) | integer | 0–20 | FIM Beta endpoint | output-format | INTEGER count of top tokens (unlike chat boolean). |

### 4.6 Mistral AI

- **API style:** Native REST `POST https://api.mistral.ai/v1/chat/completions` (OpenAI-compatible in shape). Reasoning controls also on Agents/Conversations endpoints via a `completion_args` object.
- **Latest models:** mistral-medium-3-5-26-04 (Medium 3.5, alias mistral-medium-latest; reasoning_effort), mistral-small-4-0-26-03 (Small 4, alias mistral-small-latest; hybrid, reasoning_effort), mistral-large-3-25-12 (Large 3, alias mistral-large-latest), ministral-3-14b/8b/3b-25-12, codestral-25-08 (FIM), devstral-2512 (agentic SWE), magistral-small/medium-latest (native reasoning — DEPRECATED, replaced by reasoning_effort on small/medium).
- **Docs:** [api](https://docs.mistral.ai/api/) · [completion](https://docs.mistral.ai/capabilities/completion/) · [reasoning](https://docs.mistral.ai/capabilities/reasoning/) · [models overview](https://docs.mistral.ai/getting-started/models/models_overview/) · [conversations chat-completion](https://docs.mistral.ai/studio-api/conversations/chat-completion)

| Name | Type | Values | Applies to | Category | Description |
|---|---|---|---|---|---|
| model | string | any model ID; *-latest or versioned | all (required) | routing | Model ID. |
| messages | array<object> | role + content (string or typed chunks) | all (required) | other | Conversation prompt. |
| temperature | number/null | recommend 0.0–0.7 (broader accepted); default varies per model | all | sampling | Sampling temperature. Use temp OR top_p. |
| top_p | number/null | 0.0–1.0 (default 1, model-dep) | all | sampling | Nucleus sampling. |
| max_tokens | int/null | ≥0 (default null/model max) | all | length | Max generated tokens. |
| random_seed | int/null | integer (default null) | all | sampling | Deterministic sampling seed. |
| stop | string/array/null | string or array (default null) | all | length | Stop sequence(s). |
| n | int/null | ≥1 (default 1) | all | output-format | Number of completions (input billed once). |
| stream | bool | true/false (default false) | all | streaming | SSE deltas, terminated by [DONE]. |
| presence_penalty | number/null | ~−2.0 to 2.0 (default 0) | all | penalty | Repetition penalty (presence). |
| frequency_penalty | number/null | ~−2.0 to 2.0 (default 0) | all | penalty | Repetition penalty (frequency). |
| response_format | object/null | {text} / {json_object} / {json_schema:{name, schema, strict}} (default text) | all (json_schema = capable models) | output-format | Output format / structured outputs. |
| tools | array<object>/null | function tools + built-in connectors (web search, code interpreter, image gen, document library) | tool-capable models | tools | Tools the model may call. |
| tool_choice | string/object | auto/none/any/required/{function} (default auto) | tool-capable | tools | Tool-call control. |
| parallel_tool_calls | bool | true/false (default true) | tool-capable | tools | Parallel tool calls. |
| prediction | object/null | {type:content, content} (default null) | predicted-output models | output-format | Predicted/speculative outputs. |
| prompt_mode | string/null | reasoning / null (default null) | reasoning-capable (small/medium) | reasoning | Intent toggle into thinking mode. |
| reasoning_effort | string/null | schema: none/minimal/low/medium/high/xhigh; docs document only high/none | small-latest, medium-3-5 (+ reasoning-capable) | reasoning | Amount of thinking before answer. |
| safe_prompt | bool | true/false (default false) | all | safety | Inject safety/guardrail system prompt. |
| prompt_cache_key | string/null | string (default null) | all (caching-eligible) | caching | Group requests for prompt caching (~10% rate). |
| guardrails | array<object>/null | GuardrailConfig objects (default null) | all | safety | Per-request guardrail config. |
| metadata | map<any>/null | object map (default null) | all | other | Arbitrary key/value metadata. |
| prefix (message-level) | bool | true/false (default false) | all (per assistant message) | output-format | Force reply to begin with that message's content. |

### 4.7 Alibaba Cloud Qwen / DashScope (Model Studio / 百炼)

- **API style:** Multiple interfaces over the same models. OpenAI-compatible Chat Completions (`{base_url}/compatible-mode/v1/chat/completions`, regional), OpenAI-compatible Responses, Anthropic-compatible Messages, and DashScope native (`.../api/v1/services/aigc/text-generation/generation` and `.../multimodal-generation/generation`, body split into `input{}`/`parameters{}`). Native exposes the most complete set; non-OpenAI params in compat mode via `extra_body` (Python) / top-level (Node).
- **Latest models:** qwen3.7-max (hybrid, on), qwen3.7-plus, qwen3.6-max-preview, qwen3.6-plus, qwen3.6-flash, qwen3.5-plus, qwen3.5-flash, qwen3-max (off by default), qwen-max/plus/flash/turbo (off), qwen3-235b-a22b (+ instruct-2507/thinking-2507), qwen3-30b-a3b (+ instruct/thinking), qwen3-next-80b-a3b-instruct/thinking, qwen3 dense 32b/14b/8b/4b/1.7b/0.6b, qwq-plus/qwq-32b (thinking always-on), qvq-max/qvq-72b-preview (visual reasoning), qwen-mt-plus/turbo (translation). Also hosted: DeepSeek, Kimi, GLM, MiniMax.
- **Docs:** [api-reference](https://www.alibabacloud.com/help/en/model-studio/qwen-api-reference/) · [via-dashscope](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-dashscope) · [text-generation](https://www.alibabacloud.com/help/en/model-studio/text-generation) · [openai-compat](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope) · [deep-thinking](https://www.alibabacloud.com/help/en/model-studio/deep-thinking) · [text-generation-model](https://www.alibabacloud.com/help/en/model-studio/text-generation-model) · [web-search](https://www.alibabacloud.com/help/en/model-studio/web-search) · [web-extractor](https://www.alibabacloud.com/help/en/model-studio/web-extractor)

| Name | Type | Values | Applies to | Category | Description |
|---|---|---|---|---|---|
| model | string | any supported model id | all (required) | routing | Model id. |
| messages | array | role system/user/assistant/tool | all (required) | other | Conversation history (multimodal content allowed). |
| input.prompt | string | free text | DashScope native (alt to messages) | other | Single-turn prompt. |
| temperature | float | [0, 2) (cannot be exactly 0); default model-dep (~0.7/1.0) | all | sampling | Sampling temperature. |
| top_p | float | compat (0,1.0); native (0,1.0]; default ~0.8 | all | sampling | Nucleus sampling. |
| top_k | integer | ≥0; null/>100 disables; default model-dep (QVQ 10, QwQ 40, most 20) | all (native; compat via extra_body) | sampling | Candidate token set size. |
| max_tokens | integer | [1, model max]; default model max | all | length | Max response length EXCLUDING CoT. |
| max_completion_tokens | integer | [1, model max] | Qwen3.7+, Kimi, GLM, MiniMax, DeepSeek | length | Max output INCLUDING CoT + response. |
| repetition_penalty | float | >0 (1.0 = none); model-dep | all (native; not compat) | penalty | Within-sequence repetition penalty. |
| presence_penalty | float | [−2.0, 2.0]; default 0.0–1.5 | all | penalty | Penalize present tokens. |
| frequency_penalty | float | [−2.0, 2.0]; default 0.0 | select models (compat); inconsistent | penalty | Frequency penalty (model/interface-dep). |
| seed | integer | native [0,2^31−1]; compat unsigned 64-bit | all | sampling | Reproducible output seed. |
| stop | string/array | stop words/token-id sequences | all | output-format | Halt on stop string/token. |
| n | integer | 1–4 (default 1) | Qwen3 non-thinking (not w/ thinking) | output-format | Number of completions. |
| stream | bool | true/false (default false) | all | streaming | SSE streaming (recommended for thinking). |
| stream_options | object | {include_usage} | all (compat) | streaming | Final usage chunk. |
| incremental_output | bool | true/false (default true for Qwen3/QwQ/QVQ) | DashScope native | streaming | Emit delta-only per chunk. |
| result_format | string | text/message (default message Qwen3+) | DashScope native | output-format | Native response payload shape. |
| response_format | object | {text}/{json_object} (+ structured on supporting) | Qwen3.7+ and select | output-format | Constrain output format. |
| tools | array | {type:function, function:{...}} | all except Qwen-VL | tools | Function/tool definitions. |
| tool_choice | string/object | auto/none/required/{function} (default auto) | all (w/ tools) | tools | Tool-call control. |
| parallel_tool_calls | bool | true/false (default false) | select models | tools | Parallel tool calls. |
| tool_stream | bool | true/false (default false) | Qwen, GLM series | tools | Stream tool-call arg deltas. |
| logprobs | bool | true/false (default false) | qwen-plus snapshots, Qwen3-VL+ and select | output-format | Return token log-probs. |
| top_logprobs | int | [0, 5] (default 0) | select (needs logprobs=true) | output-format | Candidate tokens per position. |
| enable_thinking | bool | true/false; default ON for 3.5/3.6/3.7+open-source, OFF for qwen3-max/qwen-max/plus/flash/turbo, DeepSeek v3.x/v4, Kimi k2.5/k2.6 | hybrid models | reasoning | Toggle CoT (compat via extra_body/top-level). |
| thinking_budget | integer (tokens) | [1, model max CoT]; default model max CoT | Qwen3 thinking (3.5/3.6/3.7+open-source), Kimi | reasoning | Cap reasoning tokens. |
| reasoning_effort | string | high/max (DeepSeek-V4); Responses API toggles/depth | DeepSeek-V4; Responses reasoning.effort | reasoning | Effort-style reasoning intensity. |
| preserve_thinking | bool | true/false (default false) | qwen3.7-max/plus, qwen3.6-max-preview/plus, Kimi k2.6/k2.7-code | reasoning | Re-feed prior reasoning_content (billed). |
| enable_search | bool | true/false (default false) | Qwen commercial + select Qwen3 | tools | Built-in web search (compat: no sources returned). |
| search_options | object | {search_strategy: agent/agent_max, forced_search, enable_source, enable_citation, citation_format} | models supporting enable_search | tools | Web-search behavior config. |
| translation_options | object | {source_lang, target_lang, terms[], tm_list[], domains} | qwen-mt-plus/turbo | other | Machine-translation controls. |
| enable_code_interpreter | bool | true/false (default false) | Qwen3.5 & qwen3.7-max+ thinking | tools | Built-in code interpreter. |
| vl_high_resolution_images | bool | true/false (default false) | Qwen-VL, QVQ | other | Raise per-image pixel/token ceiling. |
| vl_enable_image_hw_output | bool | true/false (default false) | Qwen-VL | other | Return rescaled input-image dimensions. |
| modalities / output_modalities | array | ["text"], ["text","audio"] (default ["text"]) | Qwen-Omni / multimodal | output-format | Output modality set. |

### 4.8 Zhipu AI / Z.ai (BigModel) — GLM Family

- **API style:** OpenAI-compatible `POST /api/paas/v4/chat/completions`. China base `https://open.bigmodel.cn/api/paas/v4/`; international `https://api.z.ai/api/paas/v4/`. API key is a two-part `id.secret` string.
- **Latest models:** glm-5.2 (flagship/default), glm-5.1, glm-5, glm-5-turbo, glm-4.7, glm-4.7-flash, glm-4.7-flashx, glm-4.6, glm-4.5, glm-4.5-air, glm-4.5-x, glm-4.5-airx, glm-4.5-flash, glm-4-32b-0414-128k; vision: glm-5v-turbo, glm-4.6v, glm-4.6v-flash, glm-4.6v-flashx, glm-4.5v.
- **Docs:** [z.ai chat-completion](https://docs.z.ai/api-reference/llm/chat-completion) · [bigmodel 对话补全](https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E5%AF%B9%E8%AF%9D%E8%A1%A5%E5%85%A8)

| Name | Type | Values | Applies to | Category | Description |
|---|---|---|---|---|---|
| model | string | glm-5.2/5.1/5/5-turbo/4.7(-flash/-flashx)/4.6/4.5(-air/-x/-airx/-flash)/4-32b-0414-128k (+ vision) | all | routing | Model code (default glm-5.2 text). |
| messages | array | role system/user/assistant/tool (min 1) | all (required) | other | Prompt input. |
| temperature | float | [0.0, 1.0], 2 dp; default 1.0 (5.x/4.7/4.6), 0.6 (4.5), 0.75 (4-32B), 0.8 (vision) | all | sampling | Randomness (ignored when do_sample=false). |
| top_p | float | [0.01, 1.0], 2 dp; default 0.95 (5.x/4.7/4.6/4.5), 0.9 (4-32B), 0.6 (vision) | all | sampling | Nucleus sampling. |
| do_sample | bool | true/false (default true) | all | sampling | Enable sampling; false = greedy (ignores temp/top_p). |
| max_tokens | int | 1–131072; cap 128K (5.x/4.7/4.6/5v-turbo), 96K (4.5), 32K (4.6v), 16K (4.5v/4-32B), 4K (autoglm) | all | length | Max output tokens. |
| stop | array of string | up to 4 items | all | length | Stop-word list. |
| stream | bool | true/false (default false) | all | streaming | SSE, terminated by [DONE]. |
| tools | array | max 128; Function/WebSearch/Retrieval/MCP schemas | function GLM-4+; web_search/retrieval GLM-4.5+ | tools | Tools the model may call. |
| tool_choice | string | only `auto` documented | GLM-5.2/5.1/5/5-Turbo/4.7/4.6 (function) | tools | Tool-call control (none/required/specific NOT documented). |
| tool_stream | bool | true/false (default false) | GLM-4.6+ (5.x/4.7/4.6) | tools | Stream function-call responses. |
| thinking | object | {type: enabled/disabled, clear_thinking: bool} (default enabled/true) | GLM-4.5+ | reasoning | CoT control. |
| thinking.type | string (enum) | enabled/disabled (default enabled) | GLM-4.5+; auto-decide on 5.x/4.6/4.5; GLM-4.7 & 4.5V compulsory | reasoning | CoT toggle. |
| thinking.clear_thinking | bool | true/false (default true) | GLM-4.5+ | reasoning | Drop (true) vs preserve (false) prior reasoning_content. |
| reasoning_effort | string (enum) | none/minimal/low/medium/high/xhigh/max (default max) | GLM-5.2 ONLY | reasoning | Effort level (only when thinking enabled). none/minimal→skip; low/med→high; xhigh→max. |
| response_format | object | {type: text/json_object} (default text); no json_schema | text models | output-format | Output format. |
| request_id | string | 6–64 chars (UUID recommended) | all | routing | Caller-supplied request id (auto if omitted). |
| user_id | string | 6–128 chars | all | safety | End-user identifier. |

### 4.9 Moonshot AI (Kimi)

- **API style:** OpenAI-compatible `/v1/chat/completions` (also an Anthropic-compatible surface). Bases: `https://api.moonshot.ai/v1` (global) and `https://api.moonshot.cn/v1` (China). Bearer auth.
- **Latest models:** kimi-k2.7-code (thinking always-on), kimi-k2.7-code-highspeed, kimi-k2.6 (256K; thinking default-on, toggleable), kimi-k2.5 (256K; toggleable), kimi-k2-thinking, kimi-k2-thinking-turbo, kimi-k2-0905-preview (256K), kimi-k2-turbo-preview (256K), moonshot-v1-8k/32k/128k, moonshot-v1-auto, moonshot-v1-*-vision-preview.
- **Docs:** [chat](https://platform.kimi.ai/docs/api/chat) · [k2.6 quickstart](https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart) · [migrating from openai](https://platform.kimi.ai/docs/guide/migrating-from-openai-to-kimi) · [start (moonshot.cn)](https://platform.moonshot.cn/docs/guide/start-using-kimi-api) · [platform.moonshot.ai](https://platform.moonshot.ai/)

| Name | Type | Values | Applies to | Category | Description |
|---|---|---|---|---|---|
| model | string | kimi-k2.7-code(-highspeed), k2.6, k2.5, k2-thinking(-turbo), k2-0905-preview, k2-turbo-preview, moonshot-v1-8k/32k/128k, -auto, -*-vision-preview | all (required) | routing | Model ID. |
| messages | array | {role, content, name?, tool_calls?, tool_call_id?, reasoning_content?}; content string or typed blocks (text/image_url/video_url) | all (required) | other | Conversation messages. |
| max_completion_tokens | integer | up to context limit (default ~1024) | all | length | Max generated tokens (preferred name). |
| max_tokens | integer | up to context limit (default ~1024) | all (OpenAI-compat alias) | length | Alias for max_completion_tokens. |
| temperature | number | 0–1 (NOT 0–2); default 0.0 (moonshot-v1) | moonshot-v1 user-settable; fixed by thinking on k2.5/k2.6 | sampling | Sampling temperature. |
| top_p | number | 0–1 (default 1.0 moonshot-v1) | moonshot-v1 user-settable; fixed 0.95 on k2.5/k2.6 | sampling | Nucleus sampling. |
| n | integer | 1–5 (default 1) | moonshot-v1; fixed 1 on k2.5/k2.6; must be 1 when temp≈0 | output-format | Number of choices (error if temp<0.3 and n>1). |
| presence_penalty | number | −2.0 to 2.0 (default 0) | moonshot-v1 | penalty | Presence penalty. |
| frequency_penalty | number | −2.0 to 2.0 (default 0) | moonshot-v1 | penalty | Frequency penalty. |
| stop | string/array | up to 5 sequences (OpenAI docs say 4), each ≤32 bytes (default null) | all | length | Stop sequence(s). |
| stream | bool | true/false (default false) | all | streaming | SSE deltas. |
| stream_options | object | {include_usage} (default false) | all (streaming) | streaming | Final usage block (Kimi also emits usage by default). |
| tools | array | {type:function, function:{...}}; max 128 | all (tool-capable) | tools | Tools the model may call (parallel calls supported). |
| tool_choice | string/object | none/auto/null/{function}; `required` NOT supported | all (tool-capable); w/ thinking only auto/none | tools | Tool-call control. |
| response_format | object | {text}/{json_object}/{json_schema} (default text) | all | output-format | Output format. |
| thinking | object | {type: enabled/disabled, keep?: all/null} | k2.7-code(-highspeed), k2.6, k2.5 (NOT moonshot-v1) | reasoning | CoT + multi-turn reasoning preservation. |
| thinking.type | enum | enabled/disabled | k2.6/k2.5 both; k2.7-code only enabled (disabled→error) | reasoning | CoT toggle (disable on k2.5/6 frees $web_search). |
| thinking.keep | enum/null | all/null | k2.7-code default all; k2.6 default null; k2.5 not supported | reasoning | Preserved Thinking (echo prior reasoning_content verbatim). |
| prompt_cache_key | string | stable string (default null) | all | caching | Context-reuse cache key. |
| safety_identifier | string | stable per-user id | all | safety | End-user identifier. |
| user | string | any (default none) | all (OpenAI-compat; superseded) | safety | Legacy end-user identifier. |

### 4.10 Cohere

- **API style:** Native Chat v2 — `POST https://api.cohere.com/v2/chat` (SSE via `stream:true`). Distinct from legacy v1 Chat (`/v1/chat`) and deprecated v1 Generate (`/v1/generate`). An OpenAI-compat Compatibility API (`/compatibility/v1/chat/completions`) also exists.
- **Latest models:** command-a-plus-05-2026 (Command A+, flagship, MoE 218B/25B active, Apache 2.0, released 20 May 2026), command-a-reasoning-08-2025 (111B, 256K ctx, ~32K out), command-a-03-2025 (256K), command-a-translate-08-2025, command-a-vision-07-2025, command-r-plus-08-2024 (104B, 128K), command-r-08-2024 (128K), command-r7b-12-2024 (128K).
- **Docs:** [v2 chat](https://docs.cohere.com/v2/reference/chat) · [chat reference](https://docs.cohere.com/reference/chat) · [chat-api](https://docs.cohere.com/docs/chat-api) · [models](https://docs.cohere.com/docs/models) · [command-a](https://docs.cohere.com/docs/command-a) · [changelog](https://docs.cohere.com/changelog)

| Name | Type | Values | Applies to | Category | Description |
|---|---|---|---|---|---|
| model | string | any compatible Command model ID | all (required) | routing | Model to use. |
| messages | array<ChatMessageV2> | role user/assistant/tool/system (+ tool_calls/tool_call_id/tool_plan) | all (required) | other | Chronological chat messages. |
| stream | bool | true/false (default false) | all | streaming | SSE stream vs single JSON body. |
| tools | array<ToolV2> | type:function + {name, description, parameters} | all (strongest on Command A/R+/R7B) | tools | Tools the model may call. |
| tool_choice | string (enum) | REQUIRED / NONE (omit = model decides) | command-r7b-12-2024 and newer | tools | Force/forbid tool calling (no specific-tool object on v2). |
| strict_tools | bool | true/false (default false) | newer Command models; experimental | tools | Force strict schema conformance (first call slower). |
| documents | array<Document\|string> | strings or {id, data} | all RAG-capable | other | Grounding/citation documents (RAG). |
| citation_options | object | {mode: FAST/ACCURATE/OFF} (also ENABLED/DISABLED phrasing) | citation-supporting models | output-format | Citation generation for RAG. |
| response_format | object | {text} / {json_object, json_schema?} (default text) | all (JSON on R+/Command A); NOT with documents or tools | output-format | Structured output. |
| safety_mode | string (enum) | CONTEXTUAL / STRICT / OFF (default CONTEXTUAL) | command-r-08-2024+; r7b only CONTEXTUAL/STRICT; not w/ tools or documents | safety | Injected safety instruction. |
| max_tokens | integer | positive int (default model max) | all | length | Max output tokens. |
| stop_sequences | array<string> | up to 5 strings | all | length | Stop sequences (text excluded). |
| temperature | number (float) | ≥0.0 (commonly 0.0–1.0); default 0.3 | all | sampling | Randomness. |
| seed | integer | integer | all | sampling | Best-effort determinism. |
| frequency_penalty | number (float) | 0.0–1.0 (default 0.0) | all | penalty | Frequency-proportional penalty. |
| presence_penalty | number (float) | 0.0–1.0 (default 0.0) | all | penalty | Equal penalty to all seen tokens. |
| k | integer | 0–500 (default 0 = disabled) | all | sampling | Top-k sampling. |
| p | number (float) | 0.01–0.99 (default 0.75) | all | sampling | Top-p/nucleus (applied after k if both set). |
| logprobs | bool | true/false (default false) | all | output-format | Return generated-token log-probs (boolean, not a count). |
| thinking | object | {type: enabled/disabled, token_budget?: positive int} | command-a-reasoning-08-2025 (+ hybrid Command A family) | reasoning | Reasoning phase: enable/disable + token budget. |

*Note: a `priority` integer field surfaced in one doc fetch but could not be corroborated — treat as low-confidence / possibly account-specific.*

---

## 5. Gap Analysis vs Our Relay

Mapping the parameter surface above onto what the relay actually forwards (per the codebase audit).

### 5.1 What reaches the upstream today (the forwarded set)

These IR fields are parsed, kept through the schema, and re-emitted by the adapters:

- `model`, `messages`, `tools`, `tool_choice`
- `stream` (transport flag; controller reads `body.stream` directly)
- `temperature` → `temperature`
- `top_p` (IR `topP`) → `top_p` / `topP`
- `max_tokens` (IR `maxOutputTokens`) → `max_tokens` / `maxOutputTokens` (Anthropic defaults to `DEFAULT_MAX_TOKENS=1024` when unset)
- `stop` → OpenAI `stop` / Anthropic `stop_sequences` / Gemini `stopSequences`
- `seed` → **OpenAI adapter only** (Anthropic & Gemini drop it)
- `response_format` → OpenAI (from `responseFormat != 'text'`), Gemini (in via `responseMimeType`); **Anthropic adapter drops it**

That is the entire reachable surface. Anything not in this list cannot reach `api.openai.com`, `api.anthropic.com`, or `generativelanguage.googleapis.com` through the relay.

### 5.2 What is dropped (with the specific call-outs requested)

| Param | Status in relay | Where it dies |
|---|---|---|
| **reasoning_effort** (OpenAI o-series / GPT-5.x) | **DROPPED — not wired at all** | No IR field; `openai/parse.ts:195-236` never reads it; `openai.ts buildChatBody` never emits it. |
| **thinking** (Anthropic extended/adaptive thinking) | **DROPPED — not wired at all** | No IR field; `anthropic/parse.ts:262-290` reads only temp/top_p/max_tokens/stop_sequences; `anthropic.ts buildChatBody` emits no thinking block. |
| **thinkingConfig / thinkingBudget / thinkingLevel** (Gemini) | **DROPPED — not wired at all** | No IR field; `gemini/parse.ts:293-328` reads only temp/topP/maxOutputTokens/stopSequences/responseMimeType. |
| **top_k / topK** | **DROPPED** | Not in IR (`chat.ts:64-73`); no parser reads it. (Supported by Anthropic ≤4.5, Gemini, Cohere `k`, Qwen, Grok `logit_bias`-adjacent — all unreachable.) |
| **seed** | **PARTIAL** — forwarded for OpenAI only; **dropped for Anthropic & Gemini** | `seed` is in the IR but `anthropic.ts`/`gemini.ts buildChatBody` ignore it. (Gemini natively supports `generationConfig.seed`; Mistral `random_seed`; Cohere/xAI `seed` — only OpenAI gets it.) |
| **logprobs / top_logprobs** | **DROPPED** | Not in IR; no parser/adapter reference. |
| **logit_bias** | **DROPPED** | Not in IR; no parser/adapter reference. |
| **frequency_penalty** | **DROPPED** | Not in IR; zero grep matches in the chat path. |
| **presence_penalty** | **DROPPED** | Not in IR; zero grep matches. |
| **n** (choices) | **DROPPED** | Never parsed. |
| **user** (end-user id) | **DROPPED for chat** | Parsed only for `/v1/embeddings`, not chat. |
| **metadata** | **DROPPED** | Present on `chatRequestSchema` IR but read by no parser and forwarded by no chat adapter — dead w.r.t. upstream. |
| **response_format / json_schema** | **PARTIAL** — OpenAI + Gemini; **dropped for Anthropic** | In IR but `anthropic.buildChatBody` ignores it; Anthropic `capabilities.json=false` 400s JSON at normalize anyway. |
| **any arbitrary/provider-proprietary key** | **DROPPED** | Both the hand-written `parseParams` extractors and the zod `.strip()` default discard it. |

### 5.3 Net effect on reasoning models

**Reasoning effort cannot be controlled through this relay at all.** Every vendor's reasoning knob — OpenAI `reasoning_effort` / `reasoning.effort`, Anthropic `thinking` + `output_config.effort`, Gemini `thinkingConfig.thinkingLevel/thinkingBudget`, xAI `reasoning_effort`, DeepSeek `thinking` + `reasoning_effort`, Mistral `reasoning_effort` / `prompt_mode`, Qwen `enable_thinking` + `thinking_budget`, GLM `thinking` + `reasoning_effort`, Kimi `thinking`, Cohere `thinking.token_budget` — lands on a wire key the relay never reads. The relay also cannot ask for or suppress thinking display/summaries, cannot set a thinking budget, and cannot honor the per-model defaults (e.g. gpt-5.1's `none`, GLM-5.2's `max`).

There is also a correctness hazard hiding behind this gap: many vendors **reject** the basic sampling params on reasoning models (OpenAI/xAI error on `temperature`/`top_p`/`stop`; Anthropic 400s `temperature`/`top_p`/`top_k` on Opus 4.7+). The relay forwards `temperature`/`top_p`/`stop` unconditionally, so routing a request at those models can produce upstream 400s — the inverse problem of the dropped-params gap, and one the recommendation should address via capability gating.

---

## 6. Recommendation

Add a **controlled extended-param channel** — a typed-but-open pass-through — rather than a blind forward-all. A raw spread or switching the chat schemas to `.passthrough()` would corrupt billing (the streaming hold estimate in `chat-relay.service.ts` only knows `maxOutputTokens`; reasoning tokens can balloon cost) and would leak unvalidated keys into per-dialect bodies. Concretely:

1. **Extend `ChatParams` with first-class IR keys** (`packages/contracts/src/chat.ts`) for the high-value missing fields: `topK`, `frequencyPenalty`, `presencePenalty`, `logprobs` / `topLogprobs`, `logitBias`, `n`, `user`, plus a dedicated reasoning model:
   - `reasoningEffort: z.enum(['none','minimal','low','medium','high','xhigh','max']).optional()` (superset across vendors; map down per provider),
   - a structured `thinking` / reasoning-budget shape (`{type:'enabled'|'disabled'|'adaptive', budgetTokens?: number}`) to cover the budget-based vendors (Anthropic `budget_tokens`, Gemini `thinkingBudget`, Cohere `token_budget`, Qwen `thinking_budget`).

2. **Read them in all three `parseParams`** (`openai`/`anthropic`/`gemini`), mapping dialect names into the one IR field: OpenAI `reasoning_effort` / `reasoning.effort`, Anthropic `thinking.budget_tokens` + `output_config.effort`, Gemini `thinkingConfig.thinkingBudget` / `thinkingLevel`.

3. **Emit them in each adapter `buildChatBody`**, translating back per provider:
   - OpenAI: `reasoning_effort` + `max_completion_tokens` for o-series/GPT-5.x; emit `frequency_penalty`/`presence_penalty`/`logprobs`/`logit_bias`/`n`/`user` for non-reasoning.
   - Anthropic: `thinking` block (adaptive vs enabled+budget per model) with the constraint that `temperature`/`top_p`/`top_k` must be **omitted when thinking is on / on Opus 4.7+**; wire `seed` is unsupported so leave dropped; map effort to `output_config.effort` on supporting models.
   - Gemini: `generationConfig.thinkingConfig` (`thinkingLevel` for 3.x, `thinkingBudget` for 2.5 — mutually exclusive), and forward `seed`, `topK`, `frequencyPenalty`, `presencePenalty`, `responseLogprobs`/`logprobs` which Gemini natively supports.

4. **Gate via capabilities** — extend `ModelCapabilities` with `reasoning` and `topK`/penalty flags so `normalize.ts` 400s unsupported combinations *and* strips/rejects sampling params the target reasoning model would reject (fixing the inverse hazard where `temperature`/`top_p`/`stop` are forwarded to models that 400 on them).

5. **Provide a scoped escape hatch** for the long tail of provider-proprietary params: add `ChatParams.providerOptions: z.record(z.unknown()).optional()` that each adapter merges **last** into the body, **only for the matching `providerType`**. This keeps it opt-in, out of the billing/estimate path, and prevents one provider's keys from poisoning another's body. Do **not** switch the chat schemas to `.passthrough()` or spread the raw wire body.

6. **Fix the existing asymmetries** while in the code: wire `seed` through for Gemini (natively supported); wire `responseFormat`/`jsonSchema` through for Anthropic where the model supports structured outputs (`output_config.format`) and update `capabilities.json`; and decide whether `metadata` should be forwarded (Anthropic `metadata.user_id`, OpenAI `metadata`/`safety_identifier`) or removed from the IR as dead.

This delivers full reasoning-effort control with per-provider translation, surfaces the widely-shared sampling params, keeps validation and billing intact, and leaves a safe, opt-in path for everything else.