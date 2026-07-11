// @actionow/spi — model-supply-greenfield 批次2: the six-aspect adapter SPI
// (§6). Aspect interfaces + error table (aspects.ts), shared signer aspect
// (signers.ts), execution pipeline + default transport (pipeline.ts), bounded
// SSE framing (sse.ts), versioned dialect registry (registry.ts), the DSL
// authoring track (dsl/: pack schema, YAML→six-aspect interpreter, minimal
// json pointer), and the seven-gate conformance suite (conformance.ts). Depends
// on @actionow/contracts (+ vitest, for the conformance gate generator) ONLY.
export * from './aspects.js';
export * from './conformance.js';
export * from './dsl/engine.js';
export * from './dsl/jsonpath.js';
export * from './dsl/schema.js';
export * from './pipeline.js';
export * from './registry.js';
export * from './signers.js';
export * from './sse.js';
