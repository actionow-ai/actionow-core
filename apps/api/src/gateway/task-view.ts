// apps/api/src/gateway/task-view.ts
//
// model-supply-greenfield 批次4 — TaskRow → the EXTERNAL Task object (§5 API
// 形状). The projection was HOISTED to the engine in slice4 (the §7.6 webhook
// event envelope must carry the SAME full Task body the API serves — one
// source, packages/engine/src/gateway/task-view.ts); this module re-exports
// it so slice3 import paths keep working.
export { toTaskEventView, toTaskView } from '@actionow/engine';
