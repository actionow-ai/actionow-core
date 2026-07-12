// packages/engine/src/planner/fetch-plan.ts
//
// model-supply-greenfield 批次3 slice 3a — §3 范式与取数解耦 (paradigm/fetch
// decoupling), the planner's two ORTHOGONAL planning reads:
//
//   - planParadigm (对外范式挂模型, hard principle #2): what lifecycle SHAPE the
//     caller sees (sync / stream / task) — decided ONLY from the model's
//     operation surface (paradigms + slow marker + dynamic-config thresholds).
//     It NEVER reads an offering's fetch_profile.
//   - planFetch (取数挂供给项): how the SELECTED offering's upstream delivers —
//     decided ONLY from offering.fetch_profile. It NEVER reads the model's
//     paradigm declarations.
//
// The two functions are deliberately independent (§1 原则2 hard requirement):
// a slow model may answer 202+Task while its offering fetches via a single
// blocking `direct` call, and a sync model may sit on a `submit_poll` upstream
// the worker drains before responding.
//
// PURE LOGIC — no I/O, no db, no state.
import type {
  FetchMode,
  FetchProfile,
  ModelOperation,
  Operation,
  Paradigm,
} from '@actionow/contracts';

/**
 * The external paradigms the planner can actually plan (§2.1). `realtime` is a
 * reserved enum slot (§13 — no design, no implementation) and never planned.
 */
export type ExternalParadigm = Exclude<Paradigm, 'realtime'>;

/**
 * The RECOVERABLE fetch modes (§3 / §7.2): an upstream task handle exists, so a
 * crashed worker's lease can be taken over and polling/callbacks continue.
 * These modes earn the §3 routing preference weight (sort.ts).
 */
export const RECOVERABLE_FETCH_MODES = [
  'submit_poll',
  'submit_callback',
] as const satisfies readonly FetchMode[];

/** Whether `mode` is one of the {@link RECOVERABLE_FETCH_MODES}. */
export function isRecoverableFetchMode(mode: FetchMode): boolean {
  return (RECOVERABLE_FETCH_MODES as readonly FetchMode[]).includes(mode);
}

/**
 * Dynamic-config knobs for the §3 auto-upgrade (产品裁决: 纯服务端行为,无客户端
 * opt-in). Both resolve from the settings registry (SettingsResolver) — the
 * CALLER resolves them; this module only consumes the verdicts.
 */
export interface ParadigmSettings {
  /** Master switch for server-side slow auto-upgrade; absent = enabled. */
  slowUpgradeEnabled?: boolean | undefined;
  /**
   * The 注册表阈值命中 verdict (§3: e.g. observed latency over the configured
   * ceiling for this model/operation). Threshold EVALUATION lives with the
   * dynamic-config registry (§2.6) — the caller passes the resolved boolean.
   * Absent = not hit.
   */
  thresholdHit?: boolean | undefined;
}

export interface PlanParadigmInput {
  operation: Operation;
  /**
   * The model's operation surface (§2.1) — structurally satisfied by a full
   * SupplyModelRow. planParadigm reads ONLY `operations` (对外范式挂模型);
   * it must never see a fetch_profile (§1 原则2).
   */
  model: { operations: ModelOperation[] };
  /** GatewayRequest.options.stream — the caller asked for the stream paradigm. */
  requestedStream: boolean;
  settings?: ParadigmSettings | undefined;
}

export interface ParadigmPlan {
  externalParadigm: ExternalParadigm;
  /**
   * true = a sync-declared operation was server-side upgraded to 202+Task
   * (§3 slow marker / registry threshold — 纯服务端, no client opt-in). An
   * operation that only declares `task` is BORN task, never "upgraded".
   */
  autoUpgraded: boolean;
  /** Human-readable planning trail (relay_trace / task_events observability). */
  reason: string;
}

/**
 * §3 规划器规则 — 对外范式查模型. Decision cascade:
 *
 * 1. caller requested stream AND the operation declares `stream` → stream.
 * 2. the operation declares `sync` → sync, UNLESS the slow marker or a
 *    registry threshold hit forces the auto-upgrade → task (autoUpgraded).
 * 3. the operation declares `task` (and no usable sync/stream shape) → task,
 *    natively (NOT an upgrade).
 * 4. the operation declares only `stream` (caller did not ask for it) →
 *    stream — the only shape the operation has.
 *
 * The upgrade does NOT change the idempotency-key scope or the hold timing
 * (§3: 创建时预扣 — both are slice 3b concerns); this function only decides
 * the EXTERNAL shape.
 *
 * Precondition: `operation` must be declared on the model — the routing entry
 * (assembleCandidates / the facade's contract check) validates it; an
 * undeclared operation here is a programming error and throws.
 */
export function planParadigm(input: PlanParadigmInput): ParadigmPlan {
  const op = input.model.operations.find((o) => o.operation === input.operation);
  if (op === undefined) {
    throw new Error(`planParadigm: model does not declare operation '${input.operation}'`);
  }
  const paradigms = new Set<Paradigm>(op.paradigms);

  // 1. explicit stream ask honored when the operation supports it. A stream is
  //    inherently incremental — the slow upgrade targets SYNC endpoints only
  //    (§3: images/tts 等同步端点自动改回 202+Task), so it never demotes a
  //    served stream.
  if (input.requestedStream && paradigms.has('stream')) {
    return {
      externalParadigm: 'stream',
      autoUpgraded: false,
      reason: 'caller requested stream and the operation declares the stream paradigm',
    };
  }

  // 2. default sync, unless the §3 auto-upgrade fires (slow marker or registry
  //    threshold, gated by the dynamic-config master switch).
  if (paradigms.has('sync')) {
    const upgradeEnabled = input.settings?.slowUpgradeEnabled ?? true;
    const thresholdHit = input.settings?.thresholdHit ?? false;
    if (upgradeEnabled && (op.slow || thresholdHit)) {
      return {
        externalParadigm: 'task',
        autoUpgraded: true,
        reason: op.slow
          ? 'slow marker on the operation: sync auto-upgraded to 202+Task (server-side, §3)'
          : 'registry threshold hit: sync auto-upgraded to 202+Task (server-side, §3)',
      };
    }
    return {
      externalParadigm: 'sync',
      autoUpgraded: false,
      reason: 'operation declares sync and no upgrade condition fired',
    };
  }

  // 3. natively task (task declared, no sync and no serviceable stream ask).
  if (paradigms.has('task')) {
    return {
      externalParadigm: 'task',
      autoUpgraded: false,
      reason: 'operation declares task as its only usable paradigm (born task, not upgraded)',
    };
  }

  // 4. stream-only operation without a stream ask: stream is the only shape.
  if (paradigms.has('stream')) {
    return {
      externalParadigm: 'stream',
      autoUpgraded: false,
      reason: 'operation declares stream as its only paradigm',
    };
  }

  // Only `realtime` (reserved §13) remains — unplannable by design.
  throw new Error(
    `planParadigm: operation '${input.operation}' declares no plannable paradigm (sync/stream/task)`,
  );
}

/** §3 fetch-mode strategy markers for the SELECTED offering (取数挂供给项). */
export interface FetchPlan {
  mode: FetchMode;
  /** submit_poll / submit_callback: upstream handle exists → lease takeover (§7.2). */
  recoverable: boolean;
  /**
   * direct: NO upstream handle — crash takeover ⇒ failed + no charge, never
   * blind re-submit (§3 至多一次语义). Enforcement (task center / worker) is
   * slice 3b / 批次4; this is the marker.
   */
  atMostOnce: boolean;
  /** stream: pre-commit stays (first frame pulled before the 200 commits, §3). */
  preCommit: boolean;
}

/**
 * §3 取数策略查供给项 — derive the execution-strategy markers from the
 * offering's fetch_profile. Structurally satisfied by a full SupplyOfferingRow
 * / RoutingCandidate; this function reads ONLY `fetchProfile` and must never
 * see the model's paradigm declarations (§1 原则2 — orthogonal to
 * {@link planParadigm}).
 */
export function planFetch(offering: { fetchProfile: FetchProfile }): FetchPlan {
  const mode = offering.fetchProfile.mode;
  return {
    mode,
    recoverable: isRecoverableFetchMode(mode),
    atMostOnce: mode === 'direct',
    preCommit: mode === 'stream',
  };
}
