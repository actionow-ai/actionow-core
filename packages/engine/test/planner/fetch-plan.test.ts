// §3 paradigm/fetch planning unit tests (model-supply-greenfield 批次3 slice
// 3a): the sync/stream/task cascade, the slow/threshold server-side
// auto-upgrade (产品裁决: 无客户端 opt-in), born-task vs upgraded-task, and the
// four fetch-mode strategy markers.
import type { FetchMode, Operation } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import {
  type ExternalParadigm,
  isRecoverableFetchMode,
  isServable,
  planFetch,
  planParadigm,
} from '../../src/index.js';
import { modelOp } from './supply-fixtures.js';

const OP: Operation = 'images.generation';

describe('planParadigm (对外范式挂模型 — never reads fetch_profile)', () => {
  it('defaults to sync when the operation declares sync and nothing upgrades', () => {
    const plan = planParadigm({
      operation: OP,
      model: { operations: [modelOp(OP, { paradigms: ['sync', 'stream'] })] },
      requestedStream: false,
    });
    expect(plan).toMatchObject({ externalParadigm: 'sync', autoUpgraded: false });
  });

  it('plans stream when the caller asks for it and the operation declares it', () => {
    const plan = planParadigm({
      operation: OP,
      model: { operations: [modelOp(OP, { paradigms: ['sync', 'stream'] })] },
      requestedStream: true,
    });
    expect(plan).toMatchObject({ externalParadigm: 'stream', autoUpgraded: false });
  });

  it('falls back to the sync path when stream is requested but not declared', () => {
    const plan = planParadigm({
      operation: OP,
      model: { operations: [modelOp(OP, { paradigms: ['sync'] })] },
      requestedStream: true,
    });
    expect(plan).toMatchObject({ externalParadigm: 'sync', autoUpgraded: false });
  });

  it('auto-upgrades a slow-marked sync operation to task (server-side, autoUpgraded=true)', () => {
    const plan = planParadigm({
      operation: OP,
      model: { operations: [modelOp(OP, { paradigms: ['sync', 'task'], slow: true })] },
      requestedStream: false,
    });
    expect(plan).toMatchObject({ externalParadigm: 'task', autoUpgraded: true });
    expect(plan.reason).toContain('slow');
  });

  it('auto-upgrades on a registry threshold hit even without the slow marker', () => {
    const plan = planParadigm({
      operation: OP,
      model: { operations: [modelOp(OP, { paradigms: ['sync'] })] },
      requestedStream: false,
      settings: { thresholdHit: true },
    });
    expect(plan).toMatchObject({ externalParadigm: 'task', autoUpgraded: true });
    expect(plan.reason).toContain('threshold');
  });

  it('honors the dynamic-config master switch: slowUpgradeEnabled=false keeps sync', () => {
    const plan = planParadigm({
      operation: OP,
      model: { operations: [modelOp(OP, { paradigms: ['sync'], slow: true })] },
      requestedStream: false,
      settings: { slowUpgradeEnabled: false },
    });
    expect(plan).toMatchObject({ externalParadigm: 'sync', autoUpgraded: false });
  });

  it('never demotes a served stream: slow + stream request still plans stream', () => {
    const plan = planParadigm({
      operation: OP,
      model: { operations: [modelOp(OP, { paradigms: ['sync', 'stream', 'task'], slow: true })] },
      requestedStream: true,
    });
    expect(plan).toMatchObject({ externalParadigm: 'stream', autoUpgraded: false });
  });

  it('plans a task-only operation as task WITHOUT the upgraded flag (born task)', () => {
    const plan = planParadigm({
      operation: 'video.generation',
      model: { operations: [modelOp('video.generation', { paradigms: ['task'] })] },
      requestedStream: false,
    });
    expect(plan).toMatchObject({ externalParadigm: 'task', autoUpgraded: false });
  });

  it('plans a stream-only operation as stream even without a stream ask', () => {
    const plan = planParadigm({
      operation: OP,
      model: { operations: [modelOp(OP, { paradigms: ['stream'] })] },
      requestedStream: false,
    });
    expect(plan).toMatchObject({ externalParadigm: 'stream', autoUpgraded: false });
  });

  it('throws on an operation the model does not declare (caller precondition)', () => {
    expect(() =>
      planParadigm({
        operation: 'tts',
        model: { operations: [modelOp(OP)] },
        requestedStream: false,
      }),
    ).toThrow(/does not declare operation 'tts'/);
  });

  it('throws on a realtime-only declaration (reserved §13, unplannable)', () => {
    expect(() =>
      planParadigm({
        operation: OP,
        model: { operations: [modelOp(OP, { paradigms: ['realtime'] })] },
        requestedStream: false,
      }),
    ).toThrow(/no plannable paradigm/);
  });
});

describe('planFetch (取数挂供给项 — never reads model paradigms)', () => {
  it('direct → at-most-once, not recoverable, no pre-commit', () => {
    expect(planFetch({ fetchProfile: { mode: 'direct' } })).toEqual({
      mode: 'direct',
      recoverable: false,
      atMostOnce: true,
      preCommit: false,
    });
  });

  it('stream → pre-commit, not recoverable, not at-most-once', () => {
    expect(planFetch({ fetchProfile: { mode: 'stream' } })).toEqual({
      mode: 'stream',
      recoverable: false,
      atMostOnce: false,
      preCommit: true,
    });
  });

  it('submit_poll → recoverable (lease takeover)', () => {
    expect(planFetch({ fetchProfile: { mode: 'submit_poll' } })).toEqual({
      mode: 'submit_poll',
      recoverable: true,
      atMostOnce: false,
      preCommit: false,
    });
  });

  it('submit_callback → recoverable (lease takeover)', () => {
    expect(planFetch({ fetchProfile: { mode: 'submit_callback' } })).toEqual({
      mode: 'submit_callback',
      recoverable: true,
      atMostOnce: false,
      preCommit: false,
    });
  });
});

describe('isRecoverableFetchMode', () => {
  it('classifies exactly submit_poll / submit_callback as recoverable', () => {
    expect(isRecoverableFetchMode('submit_poll')).toBe(true);
    expect(isRecoverableFetchMode('submit_callback')).toBe(true);
    expect(isRecoverableFetchMode('direct')).toBe(false);
    expect(isRecoverableFetchMode('stream')).toBe(false);
  });
});

describe('isServable (§3 paradigm×fetch servability matrix — FOUND-1)', () => {
  it('matches the full §3 matrix exactly', () => {
    const expected: Record<ExternalParadigm, Record<FetchMode, boolean>> = {
      // sync: direct / drained stream / block-polled submit all assemble a sync answer
      sync: { direct: true, stream: true, submit_poll: true, submit_callback: true },
      // stream: passthrough + single-frame degradation only; submit needs worker synthesis
      stream: { direct: true, stream: true, submit_poll: false, submit_callback: false },
      // task: native submits + at-most-once direct; stream needs a worker drain
      task: { direct: true, stream: false, submit_poll: true, submit_callback: true },
    };
    for (const [paradigm, row] of Object.entries(expected) as [
      ExternalParadigm,
      Record<FetchMode, boolean>,
    ][]) {
      for (const [mode, servable] of Object.entries(row) as [FetchMode, boolean][]) {
        expect(isServable(paradigm, mode), `${paradigm}×${mode}`).toBe(servable);
      }
    }
  });

  it('sync serves EVERY fetch mode (the common path can never be starved by the filter)', () => {
    for (const mode of ['direct', 'stream', 'submit_poll', 'submit_callback'] as const) {
      expect(isServable('sync', mode)).toBe(true);
    }
  });
});
