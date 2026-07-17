// packages/engine/src/gateway/index.ts
//
// model-supply-greenfield 批次4 slice2 — the gateway execution service barrel:
// GatewayRequest → planExecution (批次3) → SPI pipeline (批次2) → settle (§9.2).
// The OLD-WORLD execution-service/relay hot paths are untouched — the two
// worlds coexist; this is the new one's single seam.
export * from './dialect-resolve.js';
export * from './discover.js';
export * from './enable-gate.js';
export * from './execute.js';
export * from './golden-probe.js';
export * from './persist.js';
export * from './reconcile-daily.js';
export * from './settle-task.js';
export * from './task-recovery.js';
export * from './task-view.js';
export * from './task-webhook.js';
