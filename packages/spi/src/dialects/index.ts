// model-supply-greenfield 批次2 wave2 — the code-aspect dialects. Each exports a
// concrete `Dialect` (§6) that cleared the seven-gate conformance suite
// (test/conformance/<key>.conformance.test.ts). These are the four providers
// whose streaming / signing needs exceeded the DSL's structural expressiveness
// (§6 升代码切面 判据): openai (multi-op + stream), anthropic / gemini (named-
// event SSE assembly), volc (AK/SK volc-v4 body signing + submit_poll). The DSL
// authoring track (dsl/) covers the simple-REST providers — huimeng ships as a
// YAML pack (dialects/huimeng.dialect.yaml), loaded at runtime via
// loadDialectPack, alongside the mock-vendor demonstration pack.
//
// Batch 3 (execution planner) registers these into a DialectRegistry by
// {ref, version}; the exact registration source (DB rows / seed / pack dir) is
// batch-3/5 design.
export { anthropicDialect } from './anthropic.dialect.js';
export { geminiDialect } from './gemini.dialect.js';
export { openaiDialect } from './openai.dialect.js';
export { volcDialect } from './volc.dialect.js';
