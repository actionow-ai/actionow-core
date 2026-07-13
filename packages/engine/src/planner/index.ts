// packages/engine/src/planner/index.ts
//
// model-supply-greenfield 批次3 — the execution planner's public surface.
// slice 2: §4.1 EffectiveParams resolution + §4 parameter-aware candidate
// filtering (pure logic, no I/O). slice 3a: §8 candidate assembly + ordering
// and §3 paradigm/fetch planning. slice 3b: the §7.8 gate order (limits →
// read-only quota precheck → model gate → credential pick → dual semaphore →
// hold), the (offering, credential) semaphore, and the per-offering breaker
// runtime with §2.4 429/401 credential-cooldown attribution. slice 4:
// planExecution — the composition entry (批次4 挂载点) stitching all of the
// above behind ONE call. 批次6 P5: limit-plan (额度套餐) resolution
// (resolveScopedRules — the extracted GovernanceGuard algorithm) + the
// post-admission `requests` accrual.
export * from './breaker-runtime.js';
export * from './candidates.js';
export * from './effective-params.js';
export * from './fetch-plan.js';
export * from './gate.js';
export * from './limit-plan.js';
export * from './limits.js';
export * from './param-filter.js';
export * from './plan.js';
export * from './semaphore.js';
export * from './sort.js';
