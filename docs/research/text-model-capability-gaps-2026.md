<!-- Generated 2026-06-30 by an 8-dimension capability-gap workflow + a request/response IR inventory of our relay.
     One dimension (multimodal-input vendor research) failed the structured-output retry cap and is thin here. -->

# Text-model capability gaps in our relay — the full surface beyond reasoning effort

## 1. Executive summary

Our chat relay (`packages/contracts/src/chat.ts` + the per-dialect adapters) normalizes every upstream — OpenAI, Anthropic, Gemini, and codex-oauth — through a deliberately minimal neutral IR. The cost of that minimalism is now systemic. On the **request** path we forward roughly seven knobs: `temperature`, `topP`, `maxOutputTokens`, `stop`, `seed` (OpenAI only), `responseFormat` ({type} only), plus `messages`/`tools`/`toolChoice`. On the **response** path the IR is even leaner: `ChatResponse = {message, stopReason, usage:{inputTokens, outputTokens}}`. Everything an adapter does not explicitly copy is silently dropped — at parse time (no IR field exists), at the zod-strip boundary, and at body-rebuild. The relay is not a proxy; it reconstructs a fixed body in both directions, so any field outside the ~7-param surface vanishes with **no error**.

Reasoning effort is the gap people noticed first, but it is one of nine. The relay silently drops every one of the following capability dimensions:

- **Decoding/sampling** — `presence_penalty`, `frequency_penalty`, `repetition_penalty`, `top_k`, `n`/`candidateCount`, `logprobs`/`top_logprobs`, `logit_bias`, and `seed` for Anthropic/Gemini (and the wrong wire name `seed` vs `random_seed` for Mistral). `system_fingerprint` is never surfaced, so even the seed we *do* forward to OpenAI is unverifiable.
- **Reasoning/thinking** — no `reasoning_effort`, no `thinking.budget_tokens`, no `enable_thinking`, no summary/display controls; and critically, **no preservation of the signed/encrypted thinking artifacts** the next turn requires.
- **Structured output** — we forward only the bare `{type}` of `responseFormat`; the actual `json_schema` body is never captured (`params.jsonSchema` exists in the schema but no parser populates it and no builder forwards it). Anthropic gets nothing at all (it doesn't use `response_format`).
- **Tool-calling depth** — no `parallel_tool_calls`, no `strict`, no server-side/built-in tools, no GPT-5 custom/grammar tools, and no thinking-artifact round-trip.
- **Prompt caching** — no `cache_control` forward, no `prompt_cache_key`/`x-grok-conv-id`, no cached-token usage surfaced.
- **Multimodal input** — audio/file parts are schema-admitted but `irPartToOpenAi`/`irPartToBlock` **throw** `invalid_input`; only Gemini renders them.
- **Streaming fidelity** — 7 IR event types only; thinking deltas, usage breakdown, refusal/logprob/citation deltas dropped; the OpenAI renderer has **no error frame**.
- **Statefulness/server features** — no `store`, `previous_response_id`, `conversation`, `background`, `service_tier`, `prediction`, batch.
- **Response richness/usage** — the whole usage breakdown, `reasoning_content`/`thinking`, `refusal`, `logprobs`, `citations`/grounding, `system_fingerprint`, `annotations`, and `finish_reason` fidelity are flattened.

Headline consequences:

1. **We pay full price on every call that should have hit a cache.** Cached input is 75–90% cheaper (Anthropic reads ~0.1x, OpenAI/Gemini ~90% off). We forward no `cache_control` and surface no `cached_tokens`, so even when upstream *gives* us the discount, our µUSD ledger bills 100% of input at full rate. The gateway either eats the margin or over-charges the customer — a correctness *and* trust failure.
2. **Flattened usage = mis-billing.** Our `ChatUsage = {inputTokens, outputTokens}` cannot represent reasoning tokens (billed at full output rate, often 10–50x the visible output on streamed reasoning calls), cached tokens (much cheaper), audio tokens, or Anthropic's cache-creation premium (+25%/+100%). Every reasoning or cached call is mis-priced.
3. **Dropped thinking signatures break tool use on reasoning models — hard, on turn 2.** Anthropic `thinking.signature`/`redacted_thinking`, Gemini `thoughtSignature`, OpenAI Responses `encrypted_content`, DeepSeek tool-turn `reasoning_content` must be echoed back verbatim. Our adapters skip non-`text`/`tool_use` blocks entirely and the IR has no field to hold them, so every thinking+tool agent through the relay dies with a 400 on its second message.
4. **Reasoning models 400 on params we forward unconditionally.** OpenAI o-series/GPT-5.x, xAI reasoning, and Anthropic Opus 4.7/4.8 reject `temperature`/`top_p`/`stop`/penalties. `normalizeRequest` never downgrades, so these become upstream 400 storms.
5. **Structured-output guarantees are silently void.** We forward `{type:"json_schema"}` with no schema → unconstrained free-text JSON. And we don't forward `response_format` to Anthropic at all.
6. **Determinism is unverifiable.** We drop `system_fingerprint`, so a seed user can't tell their reproducibility guarantee was voided by a backend change.

---

## 2. Gap catalog by dimension

### 2.1 Decoding / sampling

**What it is.** Token-level controls over the sampling distribution: `temperature`, `top_p`, `top_k`, `min_p`, `n`/`candidateCount`, penalties (`frequency_penalty`/`presence_penalty`/`repetition_penalty`), `logit_bias`, `seed`, and `logprobs`/`top_logprobs`. This is the **least portable** family — names, value ranges, and *response shapes* all diverge.

| Vendor | Request params | Response fields | Notes |
|---|---|---|---|
| OpenAI (Chat) | `temperature`(0-2), `top_p`(0-1), `frequency_penalty`/`presence_penalty`(-2..2), `logit_bias`(id→[-100,100]), `logprobs`(bool), `top_logprobs`(0-20, requires logprobs:true), `seed`, `n`, `stop` | `choices[].logprobs.content[].{token,logprob,bytes,top_logprobs[]}`, `choices[].logprobs.refusal[]`, `system_fingerprint` | No top_k, no min_p, no repetition_penalty. Reasoning models **400** on temperature/top_p/freq/pres/stop/logprobs/top_logprobs/logit_bias. seed meaningful only if caller reads `system_fingerprint`. n is Chat-only. |
| OpenAI (Responses) | `temperature`, `top_p`, `top_logprobs`, `seed`, `include` | `output[].content[].logprobs[].{token,logprob,bytes,top_logprobs[]}` | **No top-level logprobs bool** — must pass `include:["message.output_text.logprobs"]`; lands on output items, not `choices`. No freq/pres/logit_bias/n at top level. |
| Anthropic (Messages) | `temperature`(0-1), `top_p`, `top_k`, `stop_sequences` | — (none) | **Smallest surface.** No logprobs at all, no seed/n/logit_bias/penalties. Opus 4.7/4.8 **400** on temperature/top_p/top_k; with thinking, top_p restricted 0.95-1.0. Native API 400s on unknown fields. |
| Google Gemini | `generationConfig.{temperature(0-2),topP,topK,candidateCount,frequencyPenalty,presencePenalty,seed,responseLogprobs(bool),logprobs(int 1-20),stopSequences}` | `candidates[].avgLogprobs`, `candidates[].logprobsResult.chosenCandidates[].{token,tokenId,logProbability}`, `...topCandidates[].candidates[]` | n = `candidateCount`. logprobs gating differs: `responseLogprobs` is the bool, `logprobs` an int. Response shape **wholly different** from OpenAI (`logProbability`, not `logprob`). |
| xAI Grok | `temperature`, `top_p`, `frequency_penalty`/`presence_penalty`(-2..2), `logit_bias`, `logprobs`, `top_logprobs`(0-8), `seed`, `n`, `stop` | `choices[].logprobs.content[].{...}`, `system_fingerprint` | OpenAI-compat. No top_k/min_p/repetition_penalty. Reasoning models error on freq/pres/stop. |
| DeepSeek | `temperature`, `top_p`, `logprobs`, `top_logprobs`, `seed?`, `stop`, `frequency_penalty`(deprecated no-op), `presence_penalty`(deprecated no-op) | `choices[].logprobs.content[].{...}`, `choices[].message.reasoning_content` | Penalties accepted but ignored. **Thinking mode: temp/top_p silently ignored, logprobs ERROR.** No top_k/logit_bias/n/min_p. |
| Mistral | `temperature`, `top_p`, `frequency_penalty`/`presence_penalty`, `random_seed`, `n`, `stop` | — | **seed is `random_seed`.** No top_k/logprobs/logit_bias/min_p/repetition_penalty. A relay emitting `seed` silently loses determinism. |
| Qwen / DashScope | `temperature`([0,2), ≠0), `top_p`, `top_k`, `repetition_penalty`(>0), `presence_penalty`, `frequency_penalty`, `seed`, `n`(1-4), `stop`, `logprobs`, `top_logprobs`(0-5) | `choices[].logprobs.content[].{...}`, `output.choices[].message.reasoning_content` | **Widest native surface** — only major vendor with first-class `repetition_penalty`. But top_k/repetition_penalty are native-DashScope-only (extra_body in compat). temp ≠0. n not allowed with thinking. |
| Zhipu GLM | `temperature`([0,1]), `top_p`([0.01,1]), `do_sample`(bool, false=greedy), `stop` | `choices[].message.reasoning_content` | Very narrow. No top_k/seed/logprobs/n/logit_bias/penalties in first-party docs. |
| Moonshot Kimi | `temperature`(0-1), `top_p`, `n`(1-5, must be 1 if temp<0.3), `presence_penalty`/`frequency_penalty`(-2..2), `stop` | `choices[].message.reasoning_content` | Thinking models fix temp 1.0/top_p 0.95/n 1. No top_k/seed/logprobs/logit_bias. |
| Cohere | `temperature`(default 0.3), `p`(0.01-0.99), `k`(0-500), `frequency_penalty`/`presence_penalty`(**0..1**), `seed`, `logprobs`(bool), `stop_sequences` | `logprobs[].{token,logprob}` | **Distinct names:** top_p=`p`, top_k=`k`, stop=`stop_sequences`. Penalties clamped 0..1 — OpenAI-range 1.8 is out of range. |

**We support vs drop.** *Forward:* `temperature`, `topP`, `stop` (string[] only — a bare-string `stop` is dropped by the `asArray` flatMap), `seed` (OpenAI only; Anthropic/Gemini parse drops it). *Drop at parse:* `presence_penalty`, `frequency_penalty`, `top_k`/`topK`, `n`, `logprobs`/`top_logprobs`, `logit_bias`, `user`, `min_p`, `repetition_penalty` (`parseParams` in `openai/parse.ts:194-236` extracts only temperature/top_p/max_tokens/stop/seed/response_format.type). *Response side:* `choices[0].logprobs` is never read (`openai.ts:453-475`); `system_fingerprint` is never read and `renderOpenAIChat` (`render.ts:28-45`) **omits it**.

**Breakage.** Classification/extraction/confidence pipelines relying on logprobs get nothing back. Seed reproducibility breaks both ways (wrong rename, plus dropped `system_fingerprint`). Anti-repetition tuning silently regresses; passing OpenAI-range penalties to Cohere 400s. `n`/best-of-n collapses to single-sample (we only ever read `choices[0]`). `logit_bias` format guarantees fail open. And we forward `temperature`/`top_p`/`stop` unconditionally to reasoning models that **400** on them.

**Severity: HIGH.**

### 2.2 Reasoning / thinking

**What it is.** Controlling *how hard the model thinks* (effort enums, token budgets, on/off) and *preserving the opaque stateful artifacts* reasoning emits, which the next turn requires verbatim.

| Vendor | Request params | Response fields | Notes |
|---|---|---|---|
| OpenAI (Chat) | `reasoning_effort`(none\|minimal\|low\|medium\|high\|xhigh), `verbosity`, `max_completion_tokens` (includes reasoning) | `usage.completion_tokens_details.reasoning_tokens`, (non-official) `message.reasoning_content` | Official o-series return **no CoT text** via Chat; stateless, so reasoning never carries across turns. Per-model effort defaults differ (gpt-5.1=none, gpt-5.5=medium). |
| OpenAI (Responses) | `reasoning.effort`, `reasoning.summary`(auto\|concise\|detailed), `include[]` must contain `reasoning.encrypted_content`, `store`, `previous_response_id` | `output[]` reasoning item `{type:'reasoning', id:'rs_...', summary[], encrypted_content}`, `usage.output_tokens_details.reasoning_tokens` | **Round-trip critical:** under store=false, append the entire reasoning item (id+summary+encrypted_content) next turn or **404**. encrypted_content populates on `response.output_item.done`/`response.completed`, not `.added`. |
| Anthropic (Messages) | `thinking.type`(adaptive\|enabled\|disabled), `thinking.budget_tokens`(≥1024, <max_tokens; 400 on Opus 4.7/4.8), `thinking.display`(summarized\|omitted), `output_config.effort`(low\|medium\|high\|xhigh\|max), beta `interleaved-thinking-2025-05-14` | `content[]` `{type:'thinking', thinking, signature}`, `{type:'redacted_thinking', data}`; streaming `thinking_delta`+`signature_delta` | **Hardest round-trip.** `signature` must be echoed byte-for-byte, thinking block **first** in assistant message; modify/drop/reorder → **400**. `redacted_thinking.data` must be preserved and placed first. **Billing trap:** charged for full thinking tokens even when only summary shown. |
| Google Gemini | `thinkingConfig.thinkingLevel`(low\|medium\|high, G3), `thinkingConfig.thinkingBudget`(int, G2.5; mutually exclusive with level → 400 if both), `thinkingConfig.includeThoughts` | `parts[]` with `thought:true`, `parts[].thoughtSignature`, `usageMetadata.thoughtsTokenCount` | **G3 mandates** `thoughtSignature` on the first functionCall of each step in the current turn → **400** if missing, even at minimal thinking. Escape hatch: literal `skip_thought_signature_validator` (degrades quality). |
| xAI Grok | `reasoning_effort`(none\|low\|medium\|high; grok-4/grok-3 ERROR if supplied) | `choices[].message.reasoning_content`, `usage.completion_tokens_details.reasoning_tokens` | Returns `reasoning_content` (unlike OpenAI o-series) — relays copying "strip reasoning_content" lose Grok's CoT. |
| DeepSeek | `thinking.type`(enabled\|disabled), `reasoning_effort`(high\|max), `output_config.effort` | `choices[].message.reasoning_content`; streaming `delta.reasoning_content` | **Round-trip conditional/inverted:** V4, if prior turn made a tool call, its `reasoning_content` MUST be passed back → **400** if dropped; if no tool call, omit it. Legacy uses opposite rule. |
| Mistral | `reasoning_effort`(docs: high\|none), `prompt_mode`(reasoning\|null) | `message.content` may include a thinking chunk before the answer | Reasoning emitted inline as a think-tagged segment — text-flattening loses it. |
| Qwen / DashScope | `enable_thinking`(bool), `thinking_budget`(int), `reasoning_effort`(high\|max), `preserve_thinking`(re-feed prior CoT, billed) | `choices[].message.reasoning_content` / native `output...reasoning_content`; streaming `delta.reasoning_content` | Streaming recommended. n>1 not allowed with thinking; thinking fixes temp/top_p. |
| Zhipu GLM | `thinking.type`, `thinking.clear_thinking`(false=preserve prior CoT), `reasoning_effort`(GLM-5.2 only) | `choices[].message.reasoning_content` | GLM-4.7/4.5V think compulsorily. |
| Moonshot Kimi | `thinking.type`, `thinking.keep`(all\|null — Preserved Thinking) | `choices[].message.reasoning_content`; input `messages[].reasoning_content` | No effort enum/budget. keep:all → MUST round-trip reasoning_content verbatim (billed). Thinking fixes temp 1.0/top_p 0.95/n 1. |
| Cohere | `thinking.type`, `thinking.token_budget`(int) | `message.content` includes a reasoning/thinking block before the text block | Bundles on/off + budget; reasoning is a distinct content block. |

**We support vs drop.** *Forward:* **nothing** — no IR field for effort, budget, on/off, summary, or the Anthropic beta header. *Response side:* Anthropic `chat()` (`anthropic.ts:353-389`) handles only `text` and `tool_use` blocks; `thinking`/`redacted_thinking` blocks are **silently skipped** (so `signature`/`data` are gone). OpenAI `chat()` reads only `message.content`, never `message.reasoning_content`. Gemini drops `thoughtsTokenCount` and `part.thoughtSignature`. The IR has no field for any reasoning artifact, so even if an adapter captured it, there is nowhere to hold it and the renderer cannot echo it.

**Breakage.** Anthropic tool agents **400 on turn 2** ("thinking blocks…cannot be modified"). Gemini-3 tool agents 400 (missing thoughtSignature). OpenAI Responses agents 404 (reasoning item by id under store=false). DeepSeek V4 tool turns 400 from turn 2. Visible CoT disappears for DeepSeek/Grok/Qwen/GLM/Kimi/Cohere. Effort control is inert — clients can't turn thinking off (paying for unwanted reasoning tokens) or on, and per-model defaults aren't honored. Cost is silently wrong: reasoning tokens are unmetered because the IR usage only tracks `outputTokens` and the settle bills `ceil(streamedChars/4)` on streamed calls.

**Severity: HIGH.**

### 2.3 Structured output

**What it is.** Three tiers: (1) `json_object` (valid JSON, no schema; requires literal "json" in prompt on OpenAI/DeepSeek/Qwen/Cohere); (2) **strict `json_schema`** (constrained decoding, schema-guaranteed by construction); (3) grammar/CFG-constrained decoding (Lark/regex).

| Vendor | Request shape | Response fields | Notes |
|---|---|---|---|
| OpenAI | Chat: `response_format.{json_object \| json_schema:{name,schema,strict}}`; Responses: `text.format`; GPT-5: custom tools `format:{type:'grammar', syntax:'lark'\|'regex'}` | `message.content` (JSON string), `message.refusal`, `message.parsed`/`output_parsed`, `finish_reason` | strict subset: all props in `required`, `additionalProperties:false` mandatory, no minLength/maxLength/pattern/format/min/max; $ref/$defs incl recursive. |
| Anthropic | `output_config.format:{type:'json_schema', schema}` (**not** response_format), `tools[].strict`, beta `structured-outputs-2025-11-13` | `content[0].text` (parse it), `stop_reason`: end_turn\|refusal(200, billed)\|max_tokens | Hard subset (no min/max/multipleOf/minLength/pattern). Caps: 20 strict tools, 24 optional params, 16 union-typed → 400 "too complex". Incompatible with citations and JSON+prefill. Grammars cached 24h. |
| Google Gemini | `generationConfig.responseMimeType:'application/json'\|'text/x.enum'`, `responseSchema`(OpenAPI-3.0 subset, UPPERCASE types) **or** `responseJsonSchema`(full JSON Schema), `responseSchema.propertyOrdering` | `parts[0].text` (JSON string), SDK `.parsed` | responseMimeType MUST be set or schema ignored. **propertyOrdering** is non-standard and materially affects quality. Default order alphabetical. |
| xAI Grok | `response_format.json_schema.{name,schema,strict}` (strict defaults **true**), or json_object | `message.content`, SDK parse tuple | **Different subset:** Grok DOES enforce minLength/maxLength(≤2048)/minItems/maxItems(≤256)/minProperties/maxProperties(≤64). Rejects zero-variant enum/anyOf, boolean property schemas, items-as-array. |
| DeepSeek | `response_format.json_object` **only** (json_schema rejected), `tools[].function.strict` | `message.content` (no decode-level enforcement), `tool_calls[].function.arguments` | Only schema guarantee is via strict function-calling. Prompt MUST contain "json". |
| Mistral | `response_format.json_schema.{name,schema,strict:true}` or json_object | `message.content`, SDK `chat.parse` | Requires `additionalProperties:false`. Auto-prepends a schema system instruction. First-request compile latency. |
| Qwen / DashScope | `response_format.json_object` (json_schema **not** natively supported) | `message.content` | Prompt MUST contain "json". Schema is prompt-driven. **Thinking-mode incompatible** with json_object. |
| Zhipu GLM | `response_format.json_object` (4.5/4.6/5.x); native `json_schema` strict on **GLM-4.7+** | `message.content` | Version-gated — relay must key off model id. |
| Moonshot Kimi | `response_format.{text\|json_object\|json_schema}` | `message.content` | Verify strict enforcement vs prompt-driven per model. |
| Cohere | `response_format.{json_object \| json_object+schema}` (V2), `strict_tools` (top-level) | `message.content[].text`, `message.tool_calls` | json_object alone: prompt MUST say "Generate a JSON", nesting ≤5; with schema unlimited. **Not supported with documents or tools** → 400. |

**We support vs drop.** *Forward:* only the bare `responseFormat` `{type}` → `response_format.type` for OpenAI; `responseMimeType:application/json` for Gemini; **Anthropic does not forward it at all** (no `output_config.format`). *Drop:* the actual `json_schema` body — `params.jsonSchema` exists in `chatParamsSchema` but **no parser populates it and no `buildChatBody` forwards it** (inventory `requestDropped`), so only `{type:"json_schema"}` reaches OpenAI with no schema. Also dropped: `strict`, Gemini `propertyOrdering`/UPPERCASE types, the "json" keyword requirement, GPT-5 CFG custom tools. *Response:* `refusal` is never read; a refusal looks like a parse failure.

**Breakage.** Anthropic/Gemini silently return unconstrained free-text JSON. strict downgraded to (effectively) typeless yields intermittent missing-field output with no error. Routing a strict request to DeepSeek/base-Qwen returns unvalidated JSON. Refusals are indistinguishable from schema violations.

**Severity: HIGH.**

### 2.4 Tool-calling depth

**What it is.** Depth lives in three places we flatten: (1) request controls (`parallel_tool_calls`, full `tool_choice` lattice, `strict`, GPT-5 custom/grammar tools); (2) **server-side built-in tools** (web search, code interpreter, file search, image gen, computer use, MCP); (3) opaque round-trip artifacts that must be echoed verbatim.

| Vendor | Request params | Response fields | Notes |
|---|---|---|---|
| OpenAI (Chat) | `tools[]`(function w/ strict; custom for grammar), `tool_choice`(none\|auto\|required\|{function}\|{custom}\|{allowed_tools}), `parallel_tool_calls`, `web_search_options` (search-preview only) | `tool_calls[].{id,type,function:{name,arguments}}`, `tool_calls[].custom.{name,input}`(raw text), `finish_reason:'tool_calls'` | No hosted tools except web_search. Custom tools return RAW string — JSON-parsing them corrupts them. |
| OpenAI (Responses) | hosted `tools[]`: web_search, file_search, code_interpreter, image_generation, computer_use_preview, mcp; `tool_choice`(+allowed_tools); `parallel_tool_calls`; `max_tool_calls`; `include[]`; `previous_response_id`/`store` | output items: function_call, web_search_call, file_search_call, code_interpreter_call, image_generation_call, computer_call, mcp_call, mcp_approval_request, **reasoning**{id,encrypted_content,summary} | **reasoning items MUST be echoed** with tool outputs. Built-in tools execute on OpenAI infra (extra billing). Flattening Responses→Chat deletes ALL hosted tools + reasoning round-trip. |
| Anthropic (Messages) | `tools[]` custom + server (web_search/web_fetch/code_execution/bash/text_editor/memory), `tool_choice`{auto\|**any**\|none\|tool} + `disable_parallel_tool_use`, `mcp_servers[]`, beta headers | tool_use, server_tool_use, web_search_tool_result, **thinking{signature}**, redacted_thinking, mcp_tool_use; `stop_reason:'tool_use'` | Uses `any` not `required`. Forced tool use incompatible with thinking. Thinking blocks (with signature) must pass back unmodified and in order → **400**. |
| Google Gemini | `functionDeclarations[]`, built-in `googleSearch`/`codeExecution`/`urlContext`/fileSearch, `toolConfig.functionCallingConfig.{mode:AUTO\|ANY\|NONE, allowedFunctionNames}` | `functionCall{name,args}`(+thoughtSignature on G3), `functionResponse`, executableCode, groundingMetadata | G3 enforces thoughtSignature on first functionCall. Parallel calls must not interleave with responses → 400. Uses ANY/AUTO/NONE. |
| xAI Grok | Chat: `tools[]`, `tool_choice`(none\|auto\|required\|{function}), `parallel_tool_calls`; Responses/Agent: web_search, x_search, code_interpreter, mcp | `tool_calls[]`; Responses items + citations | Server-side tools only on Responses/Agent API. Server-tool surcharge ~$5/1k. |
| DeepSeek | `tools[]`(≤128 function), `tool_choice`(none\|auto\|required\|{function}) | `tool_calls[]`, `reasoning_content` separate | Function tools only — no hosted/MCP. Thinking-mode tool flows feed prior reasoning_content back. |
| Mistral | `tools[]` function + connectors (Agents API), `tool_choice`(auto\|none\|**any**\|**required**\|{function}), `parallel_tool_calls`, `requires_confirmation` | `tool_calls[]` | Supports both `any` and `required`. Connectors only on Agents/Conversations API. |
| Qwen / DashScope | `tools[]`, `tool_choice`(auto\|none\|required\|{function}), `parallel_tool_calls`(**default false**), `tool_stream`, `enable_search`, `enable_code_interpreter` | `tool_calls[]` / native message format | parallel_tool_calls defaults FALSE (opposite OpenAI). Built-in web search returns no sources in compat mode. |
| Zhipu GLM | `tools[]`(≤128: Function+WebSearch+Retrieval+MCP), `tool_choice` — **only `auto` documented**, `tool_stream` | `tool_calls[]`, reasoning_content | Cannot reliably force tools. Vendor-specific built-in tool schemas. |
| Moonshot Kimi | `tools[]`(≤128), `$web_search` built-in, `tool_choice`(none\|auto\|null\|{function}) — **no `required`** | `tool_calls[]`, reasoning_content | tool_choice:'required' → 400/ignored. With thinking only auto/none. |
| Cohere | `tools[]`, `tool_choice`(**REQUIRED\|NONE only**, no named), `strict_tools`, `documents[]`+`citation_options` | `tool_calls[]`, **message.tool_plan**, **message.citations[]** | Native v2 (role:tool, tool_plan, tool_call_id). Cannot force a specific tool. tool_plan + citations have no OpenAI equivalent. |

**We support vs drop.** *Forward:* `tools[]` (function tools → name/description/parameters only), `toolChoice` (auto\|none\|required\|{name}; `none` unsupported by Anthropic build, mapped to auto-ish). *Drop:* `parallel_tool_calls`, tool `strict` flag, all server-side/built-in tools (flattened to a fixed Chat body), GPT-5 custom/grammar tools, MCP, allowed_tools, and **all reasoning/thinking artifacts**. *Response:* tool-call ids ARE preserved and Gemini synthesizes ids (good). But the thinking blocks bound to the tool-call turn are skipped, so the round-trip breaks.

**Breakage.** Continuation requests on reasoning models 400 (stripped reasoning artifacts). Forcing tools silently fails on GLM/Kimi/Cohere. All server-side tools disappear (hallucinated "I cannot browse"). GPT-5 custom-tool raw-text payloads get JSON-parse-corrupted. Citations/grounding/`tool_plan` vanish (auditability + Google ToS). Server-side tool surcharges are never read → under-billing on the most expensive agentic requests.

**Severity: HIGH.**

### 2.5 Prompt caching

**What it is.** The biggest cost lever — cached input is 75–90% cheaper (Anthropic 1h writes cost 2x). Two families: (A) explicit marker-driven (Anthropic `cache_control`, Gemini `cachedContent`, Qwen `cache_control`); (B) automatic prefix caching (OpenAI/xAI/DeepSeek/Mistral/Qwen3-Max/GLM/Kimi/Gemini-implicit) needing only a byte-identical prefix + optional routing key.

| Vendor | Request params | Response (cached-token) fields | Notes |
|---|---|---|---|
| Anthropic | per-block `cache_control.{type:ephemeral, ttl:5m\|1h}` (system/tools/messages/documents/tool_results), top-level `cache_control`, ≤4 breakpoints | `usage.cache_creation_input_tokens`(+25%/+100%), `usage.cache_read_input_tokens`(~0.1x), `usage.input_tokens`, `usage.cache_creation.{ephemeral_5m_input_tokens,ephemeral_1h_input_tokens}` | Explicit. Requires 100% byte-identical prefix (tools→system→messages). Two usage numbers (creation vs read) price very differently. |
| OpenAI (Chat) | `prompt_cache_key`, `safety_identifier`/`user` | `usage.prompt_tokens_details.cached_tokens` | Automatic, ≥1024 tok. cached_tokens is a subset of prompt_tokens. |
| OpenAI (Responses) | `prompt_cache_key`, `previous_response_id`, `store` | `usage.input_tokens_details.cached_tokens` | **Different path** from Chat. |
| Google Gemini | explicit `cachedContent` ("cachedContents/{id}", created via separate API call); implicit (none) | `usageMetadata.cachedContentTokenCount` (**promptTokenCount INCLUDES it**) | Explicit needs a separate `cachedContents.create`. Net new = promptTokenCount − cachedContentTokenCount. |
| xAI Grok | **`x-grok-conv-id` (HTTP header)**, `prompt_cache_key`(Responses) | `usage.prompt_tokens_details.cached_tokens` / `input_tokens_details.cached_tokens` / `cached_prompt_text_tokens` | Routing control is a header — a body-rebuild relay drops it. Three field names. |
| DeepSeek | none (on by default) | `usage.prompt_cache_hit_tokens`, `usage.prompt_cache_miss_tokens` | **Distinct names** (prompt_tokens = hit + miss). |
| Mistral | `prompt_cache_key` | `usage.prompt_tokens_details.cached_tokens` | 64-token block size. |
| Qwen / DashScope | implicit (none) + explicit `cache_control:{type:ephemeral}` | compat: `prompt_tokens_details.cached_tokens`; native: folded into `input_tokens` (+`cached_content_token_count`) | Field location depends on interface flavor. |
| Zhipu GLM | none (does **not** accept cache_control) | `usage.prompt_tokens_details.cached_tokens` | Auto-injecting cache_control here is wrong. |
| Moonshot Kimi | automatic; explicit `/v1/caching` | `usage.cached_tokens` (**top-level**) or `prompt_tokens_details.cached_tokens` | Can report at top level. |
| Cohere | none documented | none documented | Treat as unsupported. |

**We support vs drop.** *Forward:* **nothing** — no `cache_control` (the IR's ~7 fields can't represent breakpoints), no `prompt_cache_key`, no `x-grok-conv-id`, no Gemini `cachedContent` lifecycle. *Response:* the relay reads only `prompt_tokens`/`input_tokens` and `completion_tokens`/`output_tokens` (`anthropic.ts:353-389`, `gemini.ts:209-216`, `openai.ts:453-475`); every cached-token field is dropped. **Additional risk:** the relay rebuilds bodies (3-layer whitelist) and synthesizes ids — any re-serialization, key reorder, or whitespace change busts byte-identical prefixes and silently zeroes automatic-cache hits.

**Breakage.** Anthropic: every request is a full-price miss (5–10x cost blow-up, undiagnosable). Gemini explicit: the pre-paid cache sits unused while storage is billed. Billing over-charge: DeepSeek/Anthropic/Gemini/Kimi/native-Qwen all report zero cached tokens to us, so we bill 100% of input even when upstream gave a 75–90% discount. Routing-key drop collapses hit rate non-deterministically.

**Severity: HIGH.**

### 2.6 Multimodal input

**What it is.** Non-text request content parts: image, audio, file/document. (This dimension is drawn from the IR inventory + the vendor surfaces above.)

**We support vs drop.** *Forward:* text + image parts. *Drop/reject:* audio and file parts are **schema-admitted** and normalize-gated, but `irPartToOpenAi` (`openai.ts:64-75`) and `irPartToBlock` (`anthropic.ts:64-74`) **throw `invalid_input`**; only `gemini.ts:41-53` renders them as `inlineData`/`fileData`. Image `detail` hint is not parsed. The capability gate (`normalize.ts:11-34`) 400s on `audio`/`file` content + `!caps.audio`/`!caps.file`, but there is also a **secondary hard-fail**: even an audio-capable model served by an OpenAI-dialect channel 400s at build time because the part renderer throws.

**Breakage.** An audio- or file-capable model is unreachable through any OpenAI/Anthropic-dialect channel — the only working multimodal-input path is Gemini. Image `detail` (cost/quality control) is silently dropped.

**Severity: MEDIUM-HIGH** (capability simply unavailable on two of three dialects; correctness is fail-loud via 400, not silent corruption).

### 2.7 Streaming fidelity

**What it is.** Three structurally different SSE taxonomies (OpenAI delta-chunks, OpenAI Responses ~25 semantic events, Anthropic named events, Gemini full-response chunks) that are not interchangeable, plus streamed usage, signed-thinking deltas, and tool-call delta framing.

| Vendor | Stream request | Key stream fields | Notes |
|---|---|---|---|
| OpenAI (Chat) | `stream`, `stream_options.include_usage`, `stream_options.include_obfuscation` | `choices[].delta.{content,role,refusal,tool_calls[].index,...}`, `finish_reason`, final `usage` chunk (`choices:[]`) | **Usage OFF by default** — needs `include_usage:true`; one extra chunk before `[DONE]`. May never arrive if interrupted. |
| OpenAI (Responses) | `stream`, `background`, `store`, `include[]`, `starting_after` | ~25 typed events w/ `sequence_number`; `response.completed` carries usage; resumable | Usage in final object. Resume window ~5-10 min. |
| Anthropic | `stream`, thinking params, beta headers | `message_start`(input usage), `content_block_delta.{text_delta\|thinking_delta\|signature_delta\|input_json_delta}`, `message_delta`(cumulative output usage), `ping` | display:'omitted' → no thinking_delta, only signature_delta. Thinking blocks must round-trip. |
| Google Gemini | `:streamGenerateContent`, `?alt=sse` | each chunk a full GenerateContentResponse; `part.thought`, `part.thoughtSignature`; cumulative usageMetadata | thoughtsTokenCount can be absent. Naive proxies have corrupted SSE by wrapping in Python bytes literals. |
| xAI/DeepSeek/Mistral/Qwen/GLM/Kimi | `stream`, `stream_options.include_usage` (Kimi emits usage by default), Qwen `incremental_output`/`tool_stream` | `delta.content`, **`delta.reasoning_content`**, `delta.tool_calls[].index`, vendor usage | Qwen native cumulative-output mode duplicates text if treated as deltas. DeepSeek thinking streams reasoning_content first. |
| Cohere | `stream` | named events `content-delta`(`delta.message.content.text`), `tool-call-start/delta/end`, `citation-start/end`, `message-end.delta.usage.{billed_units,tokens}` | UPPERCASE finish_reason. Two usage counts. |

**We support vs drop.** The IR `ChatStreamEvent` union has **exactly 7 variants** (`chat.ts:105-118`): `message_start`, `content_delta{text}`, `tool_call_delta{index,id?,name?,argumentsDelta?}`, `usage{inputTokens,outputTokens}`, `stop{stopReason}`, `done`, `error`. *Preserved:* text deltas, tool-call deltas (id/name/incremental args; Gemini hoists a stream-global toolIndex for parallel calls; Anthropic maps `input_json_delta`), one usage event (2 ints), stopReason. *Dropped/collapsed:* thinking/reasoning deltas (`anthropic.ts:445-462` handles only text_delta + input_json_delta — `thinking_delta` silently ignored; OpenAI `delta.reasoning_content` ignored), usage breakdown in the trailing chunk, refusal/logprob/citation deltas. **The OpenAI stream renderer (`openai/stream.ts:93-100`) has NO error frame** — a mid-stream error degrades to an empty stop chunk + `[DONE]`; the client never sees the upstream failure. On a no-usage end, the engine bills a measured partial `ceil(streamedChars/4)` (`stream.ts:427-449`).

**Breakage.** Streamed calls have no real token usage → we bill from an estimate; reasoning models emit 10–50x hidden reasoning tokens, so we massively mis-charge. Anthropic next-turn hard 400 if thinking flattened. Gemini/DeepSeek-V4/Kimi multi-turn collapse. Disappearing CoT for clients expecting `delta.reasoning_content`. The missing error frame means clients silently get truncated answers on upstream failure.

**Severity: HIGH.**

### 2.8 Statefulness / server features

**What it is.** Server-managed state (`store`, `previous_response_id`, `conversation`, `background`, stored prompts), service tiers, predicted outputs, and batch APIs — plus the encrypted-reasoning round-trip that *is* the statefulness mechanism for reasoning models.

| Vendor | Request params | Response fields | Notes |
|---|---|---|---|
| OpenAI (Responses) | `store`(default true), `previous_response_id`, `conversation`, `background`, `prompt`{id,version,variables}, `include[]`, `service_tier`(auto\|default\|flex\|priority), `truncation` | `id`, reasoning items w/ encrypted_content, `status`, `service_tier`(echo), `usage.input_tokens` (full prior chain re-billed) | Statefulness is the point. store=false+include encrypted_content for ZDR. instructions NOT carried by previous_response_id. |
| OpenAI (Chat) | `store`(default false), `prediction`, `service_tier`, `prompt_cache_key` | `usage.completion_tokens_details.{accepted_prediction_tokens,rejected_prediction_tokens,reasoning_tokens}`, `service_tier`, `system_fingerprint` | Cannot preserve reasoning traces across turns. rejected_prediction_tokens billed at full rate. |
| OpenAI (Batch) | `/v1/batches`: input_file_id, endpoint, completion_window, custom_id | batch id, status, output_file_id | 50% off, 24h, no streaming. Separate endpoint. |
| Anthropic | `thinking`, echo prior thinking blocks w/ signature, `service_tier`(auto\|standard_only), `container`, `cache_control`; Batches `/v1/messages/batches` | thinking block w/ signature, container.id, usage | No server conversation state, but signature round-trip is mandatory during tool use. |
| Google Gemini | `cachedContent`, `serviceTier`, `store`, `labels`; `batchGenerateContent` | batch job name, state, cachedContent usage | Stateless generateContent. |
| xAI Grok | `store`, `previous_response_id`, `include[]`, `reasoning.effort` (Responses); `deferred` (Chat) | response id, request_id | deferred=true async polling. |
| DeepSeek | `messages[].prefix`(Beta), `messages[].reasoning_content`(Beta), `thinking` | reasoning_content | Statefulness = client-carried reasoning_content via prefix. |
| Mistral | `prediction`, `prompt_cache_key`; Batch; Agents/Conversations | batch id, conversation id | Server-side conversations on Agents API. |
| Qwen / DashScope | `preserve_thinking`, `enable_thinking`/`thinking_budget` | reasoning_content, cached usage | preserve_thinking re-feeds CoT (billed). |
| Zhipu GLM | `thinking.clear_thinking`(false=preserve), `request_id`, `user_id` | reasoning_content, request_id | Preserved-Thinking needs re-sent reasoning_content. |
| Moonshot Kimi | `thinking.keep`(all\|null), `messages[].reasoning_content`, `prompt_cache_key` | reasoning_content | Preserved Thinking. |
| Cohere | `thinking`, `documents[]`, `citation_options` | citations, usage | Lowest statefulness surface. |

**We support vs drop.** *Forward:* none. The IR knows only `{model, messages, temperature, top_p, max_tokens, stop, seed, response_format}` — `store`, `previous_response_id`, `conversation`, `background`, `prompt`, `service_tier`, `prediction`, batch, and the encrypted-reasoning round-trip are all absent. `ir.metadata` is parsed but never forwarded (`chat-relay.service.ts:226`; no `buildChatBody` reads it).

**Breakage.** Anthropic 400 on every thinking+tool turn. OpenAI reasoning quality silently degrades (no encrypted_content round-trip; cache hit rate ~80%→40%). Multi-turn chaining 404s. Stored Prompt templates ignored. background/deferred hangs. service_tier=flex/batch loses 50% discount; chaining re-bills the whole prior chain as input that our `maxOutputTokens` hold never anticipated → under-collection or 402s.

**Severity: HIGH.**

### 2.9 Response richness / usage

Covered in depth in Section 3.

---

## 3. Response-side gaps — what we FLATTEN on the way back

The response path is the most overlooked because, unlike request params, these fields appear in the *upstream* response and our adapters' `mapResponse` reconstructs a canonical envelope that copies only what it explicitly names. `ChatResponse = {message, stopReason, usage:{inputTokens, outputTokens}}` (`chat.ts:89-99`). Everything else is gone.

**(1) Usage breakdown — flattened to two integers.** We capture only `prompt_tokens`/`input_tokens` → `inputTokens` and `completion_tokens`/`candidatesTokenCount` → `outputTokens`. We drop, with nowhere to put them:
- OpenAI `usage.prompt_tokens_details.{cached_tokens, audio_tokens}`, `usage.completion_tokens_details.{reasoning_tokens, audio_tokens, accepted_prediction_tokens, rejected_prediction_tokens}` (`openai.ts:453-475` never reads `*_tokens_details`).
- Anthropic `usage.{cache_creation_input_tokens, cache_read_input_tokens, cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}, service_tier}` (`anthropic.ts:353-389` reads only input/output_tokens).
- Gemini `usageMetadata.{thoughtsTokenCount, cachedContentTokenCount, toolUsePromptTokenCount, *TokensDetails[]}` (`gemini.ts:209-216`).
- DeepSeek `usage.{prompt_cache_hit_tokens, prompt_cache_miss_tokens}` + `completion_tokens_details.reasoning_tokens`.
- xAI `usage.num_sources_used` (+ Responses `num_server_side_tools_used`, `cost_in_usd_ticks`).
- Cohere `usage.billed_units` (what you pay, incl. `search_units`) vs `usage.tokens` (raw count).

This directly corrupts the µUSD ledger: reasoning tokens are billed at full output rate but invisible; cached tokens are 75–90% cheaper; Anthropic cache-creation is a +25%/+100% *premium*, not a discount. **Gemini double-count trap:** `promptTokenCount` already includes cached/thinking tokens — adding them double-counts. **Gemini API vs Vertex:** Gemini API folds thinking into `candidatesTokenCount`; Vertex separates it.

**(2) finish_reason / stop_reason fidelity — collapsed to a 5-value enum.** `STOP_REASONS = stop|length|tool_calls|content_filter|error` (`chat.ts:86-87`). We lose:
- Anthropic `pause_turn` (REQUIRES resubmit to continue a long agentic turn), `refusal` (a 200 safety block, elevated on Fable 5), `model_context_window_exceeded`, `stop_sequence` (collapses to `stop` and renders back as `end_turn`), and the `stop_details` object.
- DeepSeek `insufficient_system_resource` (truncated).
- Gemini `RECITATION`/`SAFETY`/`MALFORMED_FUNCTION_CALL`/etc. (RECITATION folds into content_filter then renders as "SAFETY").
- Cohere UPPERCASE values.
- OpenAI Responses `status='incomplete'` + `incomplete_details.reason='max_output_tokens'` (bills input+reasoning tokens with **zero visible output** — we'd report it as a clean stop).

**(3) reasoning_content / thinking — silently skipped.** Anthropic `thinking`/`redacted_thinking` blocks (with `signature`/`data`) are skipped by the `chat()` block loop. OpenAI/DeepSeek/Grok/Qwen/GLM/Kimi `message.reasoning_content` is never read. Mistral's content-as-array ThinkChunk is flattened (we assume `content` is a string). Beyond losing the visible CoT panel, this destroys the byte-perfect round-trip → hard 400 on turn 2 for thinking+tool conversations.

**(4) citations / grounding — never read.** Anthropic `citations` content blocks; Gemini `groundingMetadata.{webSearchQueries, searchEntryPoint.renderedContent, groundingChunks[].web.{uri,title}, groundingSupports[].{segment, groundingChunkIndices, confidenceScores}}` and `citationMetadata`; Cohere `message.citations` + `message.tool_plan`; xAI top-level `citations` + `usage.num_sources_used`; OpenAI `message.annotations[]` (url_citation). **Google's ToS contractually requires rendering `searchEntryPoint.renderedContent` unmodified — dropping it is a compliance violation, not just a feature loss.**

**(5) logprobs — never read.** OpenAI `choices[0].logprobs.{content,refusal}[].{token,logprob,bytes,top_logprobs}`, Gemini `avgLogprobs`/`logprobsResult`, Cohere `logprobs[]`. Confidence scoring, perplexity/guardrail checks, and token-level highlighting all break.

**(6) refusal — folded away.** OpenAI/xAI `message.refusal` (a distinct structured string) is never read; apps that branch on refusals can't distinguish a refusal from empty content.

**(7) system_fingerprint — omitted.** OpenAI/xAI/Qwen-compat `system_fingerprint` is never read, and `renderOpenAIChat` (`render.ts:28-45`) synthesizes a fresh `chatcmpl-<uuid>` and omits it. It is the only signal that seed determinism held across a backend change.

**(8) Provider response id & structure.** OpenAI `id`, Anthropic `id`, Gemini `responseId` are discarded (renderers synthesize). OpenAI multi-choice `n>1` collapses to `choices[0]`. Anthropic content-block ordering/interleaving with thinking/tool blocks is lost. Gemini `safetyRatings` rendered as empty `[]`.

---

## 4. Prioritized remediation roadmap

Ranked by impact/effort. Each item lists what changes in IR/parsers/adapters/capabilities and the billing/correctness implication.

### (a) Typed-but-open passthrough "extra" bag + normalized reasoning effort/budget mapping — **highest impact / lowest effort**
- **IR:** add `params.extra: Record<string, unknown>` (typed-but-open) carried through parse → build untouched per dialect, plus a first-class normalized `params.reasoning: {effort?: enum, budget?: int, enabled?: bool, summary?: enum}`.
- **Parsers:** `parseParams` (`openai/parse.ts`) captures `presence_penalty`/`frequency_penalty`/`top_k`/`n`/`logprobs`/`top_logprobs`/`logit_bias`/`user`/`reasoning_effort`/`parallel_tool_calls` into `extra` (and the structured `reasoning`). Fix the bare-string `stop` coercion so a single-string stop survives.
- **Adapters/builders:** each `buildChatBody` merges `extra` into the upstream body with per-vendor name/range translation (seed→`random_seed` for Mistral, top_p→`p`/top_k→`k` for Cohere, n→`candidateCount` for Gemini); maps the normalized `reasoning` down per provider (OpenAI `reasoning_effort`/`reasoning.effort`, Anthropic `output_config.effort`+`thinking.budget_tokens`, Gemini `thinkingLevel` vs `thinkingBudget` never both, Qwen `enable_thinking`+`thinking_budget`, etc.).
- **Capabilities:** gate sampling params reasoning models reject (strip temperature/top_p/stop/penalties for OpenAI/xAI reasoning; temperature/top_p/top_k for Opus 4.7+) — this is the place `normalize.ts` should finally *downgrade*, not just 400.
- **Billing/correctness:** ends the 400-storm on reasoning models, lets clients trade cost vs quality (turn thinking off to stop paying for reasoning tokens), restores penalty/top_k/n/logprobs/logit_bias.

### (b) Prompt-caching forward + cache-token usage surfacing — **highest cost impact**
- **IR:** carry per-block `cache_control` (Anthropic), top-level `prompt_cache_key`, and a header passthrough for `x-grok-conv-id`; extend `ChatUsage` with `cachedInputTokens`, `cacheCreationTokens` (+ 5m/1h split), and a robust cached-token parse.
- **Parsers/builders:** preserve byte-identical prefixes — stop re-serializing/reordering/whitespace-normalizing the cacheable prefix and renumbering tool ids; allowlist Anthropic-style `cache_control` injection (exclude GLM/Zhipu/automatic cachers).
- **Adapters:** read `cache_read_input_tokens`/`cache_creation_input_tokens` (Anthropic), `prompt_tokens_details.cached_tokens` / `input_tokens_details.cached_tokens` (OpenAI Chat/Responses), `cachedContentTokenCount` (Gemini, remember promptTokenCount includes it), `prompt_cache_hit_tokens`/`miss` (DeepSeek), top-level `cached_tokens` (Kimi). Default missing to 0, never null.
- **Billing/correctness:** price cached portion at the discounted rate per vendor and cache-creation as a premium. Stops paying full price on cache hits — a 5–10x cost line for long-system-prompt agents. Persist the breakdown in `relay_trace`/`usage_log`.

### (c) Response-fidelity preservation + signed-thinking round-trip — **highest correctness impact**
- **IR:** keep assistant content as a **structured block array**, never a single string. Add IR fields for reasoning artifacts: Anthropic `thinking{thinking,signature}`/`redacted_thinking{data}` (preserve order, position-first), Gemini `thoughtSignature` per part, OpenAI Responses `reasoning{id,encrypted_content,summary}`, generic `reasoning_content`. Add `refusal`, `logprobs`, `citations`/grounding, `system_fingerprint`, provider response id, and full `usage` breakdown. Widen `STOP_REASONS` to retain `pause_turn`/`refusal`/`stop_sequence`/`model_context_window_exceeded`/`insufficient_system_resource` + `stop_details`.
- **Parsers/adapters:** stop type-filtering unknown content blocks (`anthropic.ts:353-389`, stream `:445-462`); read `reasoning_content` (`openai.ts`), `thoughtsTokenCount`/grounding (`gemini.ts`); echo the assistant message verbatim on the next turn rather than rebuilding it. Add an **error frame to the OpenAI stream renderer** (`openai/stream.ts:93-100`).
- **Streaming:** add `thinking_delta`/`signature_delta`/usage-detail/refusal/citation events to the IR union; capture streamed usage from each shape and sum reasoning tokens instead of estimating `ceil(streamedChars/4)`.
- **Billing/correctness:** fixes the catastrophic Anthropic turn-2 400, OpenAI reasoning context/cache loss, agent-loop branching on `pause_turn`/`refusal`, the Google ToS grounding requirement, and bills reasoning tokens correctly. Surface `system_fingerprint` so determinism is verifiable.

### (d) Structured-output strict json_schema per provider — **high impact / medium effort**
- **IR:** populate and forward `params.jsonSchema` (the field already exists, unused), plus `strict`.
- **Parsers/builders:** capture `response_format.json_schema.schema`; translate to the per-vendor shape — OpenAI `response_format.json_schema`, OpenAI Responses `text.format`, **Anthropic `output_config.format` (currently not forwarded at all)**, Gemini `responseSchema`+`responseMimeType`+`propertyOrdering`. Preserve the "json" keyword requirement; validate against per-vendor subset or relay the 400; gate by model id (GLM-4.7+, etc.).
- **Billing/correctness:** restores schema-guaranteed output; preserves byte-identical schema for grammar/prompt-cache hits (ties into (b)).

### (e) Tool-calling depth + server-side tools — **high impact / higher effort**
- **IR:** add `parallel_tool_calls`, tool `strict`, the full `tool_choice` lattice (incl. `any`/named gating per vendor), server-side/built-in tool descriptors, and MCP. Round-trip reasoning artifacts on tool turns (depends on (c)).
- **Adapters:** stop flattening Responses/Anthropic server tools to a fixed Chat body; map `tool_choice` per vendor (Anthropic `any`, Gemini ANY/AUTO/NONE; refuse-or-warn on GLM/Kimi/Cohere forcing); handle GPT-5 custom/grammar tools as raw text, not JSON.
- **Billing/correctness:** restores web search/code interpreter/file search/MCP and grounding; reads server-side tool surcharges into the ledger (the most expensive agentic requests are currently under-billed).

### (f) Multimodal input parts — **medium impact / medium effort**
- **Adapters:** implement `irPartToOpenAi`/`irPartToBlock` for audio/file instead of throwing (`openai.ts:64-75`, `anthropic.ts:64-74`); parse the image `detail` hint.
- **Capabilities:** the secondary build-time hard-fail must align with `caps` so an audio-capable model on an OpenAI-dialect channel works.
- **Billing/correctness:** unlocks multimodal input beyond Gemini; image `detail` affects token cost.

### (g) Streaming usage / deltas — **folds into (b)+(c)**
- Inject `stream_options.include_usage:true` even when the client didn't ask (record, then optionally strip the extra chunk); capture the final usage chunk / `response.completed.usage` / `message_delta.usage` / `usageMetadata`; respect Qwen `incremental_output` (cumulative vs delta); don't corrupt Gemini SSE.
- **Billing/correctness:** ends estimate-based billing of streamed reasoning calls — the single largest streaming cost/correctness failure.

### (h) Statefulness / server features — **lower priority, separate endpoints**
- Forward `store`/`previous_response_id`/`conversation`/`background`/`prompt`/`service_tier`/`prediction`; forward `ir.metadata` (parsed but dropped). Batch APIs are separate endpoints — a distinct project. Account for full-prior-chain re-billing in the hold.

---

## 5. Capability matrix

| Dimension | Vendor surface richness | Our support today | Severity | Fix bucket |
|---|---|---|---|---|
| Decoding/sampling | Very high, least portable (names/ranges/response shapes all diverge; reasoning-model rejection) | **Partial** — temperature/topP/stop/seed(OpenAI) fwd; penalties/top_k/n/logprobs/logit_bias/min_p/rep_penalty dropped; logprobs/system_fingerprint never read | High | (a) |
| Reasoning/thinking | Very high, most round-trip-fragile (effort enums + budgets + signed artifacts) | **None** — no effort/budget/on-off forwarded; thinking blocks & reasoning_content dropped; no artifact round-trip | High | (a)+(c) |
| Structured output | High, 3-tier with per-vendor shapes/subsets | **Partial** — only `{type}` fwd; schema body never captured; Anthropic gets nothing; refusal not read | High | (d) |
| Tool-calling depth | Very high (controls + server tools + artifacts) | **Partial** — function tools + tool_choice + ids preserved; parallel/strict/server-tools/custom/MCP/artifacts dropped | High | (e) |
| Prompt caching | High, biggest cost lever, two families | **None** — no cache_control/cache_key/cachedContent fwd; all cached-token usage dropped; prefix-busting risk | High | (b) |
| Multimodal input | Medium-high (image universal; audio/file vendor-split) | **Partial** — text+image only; audio/file throw on OpenAI/Anthropic dialects (Gemini-only); detail hint dropped | Med-High | (f) |
| Streaming fidelity | Very high, 3+ SSE taxonomies | **Partial** — text/tool deltas + 2-int usage + stop preserved; thinking/usage-detail/refusal/logprob/citation deltas dropped; OpenAI renderer has no error frame | High | (c)+(g) |
| Statefulness/server | High (Responses-first; store/chaining/tiers/batch/prediction) | **None** — none forwarded; metadata parsed-then-dropped | High | (h) |
| Response richness/usage | Very high (usage sub-objects, finish-reason fidelity, citations, logprobs, fingerprint, refusal) | **None of the richness** — flattened to {message, 5-value stopReason, 2-int usage}; everything else dropped | High | (b)+(c) |

**Bottom line:** of nine dimensions, two are fully missing in both directions (reasoning/thinking, prompt caching), two are missing on the request side and flattened on the response side (statefulness, response richness), and the rest are partial. The two changes with the best impact/effort ratio are **(a)** the typed-open passthrough bag + normalized reasoning mapping (unblocks decoding + reasoning effort + reasoning-model 400s in one move) and **(b)** prompt-caching forward + cached-token surfacing (the single biggest cost correction). **(c)** response-fidelity + signed-thinking round-trip is the highest *correctness* priority because it is the one that produces hard, silent turn-2 400s on every thinking+tool agent and directly mis-bills reasoning tokens against the µUSD ledger.