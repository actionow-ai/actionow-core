// @actionow/spi — model-supply-greenfield 批次2: the six-aspect adapter SPI
// (§6). Aspect interfaces + error table (aspects.ts), shared signer aspect
// (signers.ts), execution pipeline + default transport (pipeline.ts), bounded
// SSE framing (sse.ts), versioned dialect registry (registry.ts), the DSL
// authoring track (dsl/: pack schema, YAML→six-aspect interpreter, minimal
// json pointer), and the wave2 code-aspect dialects (dialects/). Depends on
// @actionow/contracts ONLY.
//
// The seven-gate conformance suite lives in `conformance.ts` and is NOT
// re-exported here: it imports `vitest` (a devDep) and must never load in a
// production consumer whose devDeps are pruned (batch-3 engine imports this
// barrel). Reach it via the `@actionow/spi/conformance` subpath export instead.
export * from './aspects.js';
export * from './builtin.js';
export * from './dialects/index.js';
export * from './dsl/engine.js';
export * from './dsl/jsonpath.js';
export * from './dsl/schema.js';
export * from './pipeline.js';
export * from './registry.js';
export * from './signers.js';
export * from './sse.js';
