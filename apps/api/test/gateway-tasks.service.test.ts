// 批次4 slice3 — GatewayTasksService unit tests (fake repo surface): the §7.7
// LOCAL cancel state machine (guarded transition + hold release, idempotent
// canceled, terminal conflict, terminal-race re-read) and subject isolation.
import type { Database } from '@actionow/db';
import { describe, expect, it, vi } from 'vitest';

import { GatewayTasksService, type TaskQueries } from '../src/gateway/tasks.service.js';
import { taskRow } from './gateway-fixtures.js';

function serviceWith(queries: Partial<TaskQueries>): {
  service: GatewayTasksService;
  queries: TaskQueries;
} {
  const full: TaskQueries = {
    getTaskByIdForTenant: vi.fn().mockResolvedValue(undefined),
    listTasks: vi.fn().mockResolvedValue({ rows: [], hasMore: false }),
    listTaskEvents: vi.fn().mockResolvedValue([]),
    failGatewayTask: vi.fn().mockResolvedValue({ settled: false }),
    ...queries,
  };
  const service = new GatewayTasksService({} as Database);
  (service as unknown as { queries: TaskQueries }).queries = full;
  return { service, queries: full };
}

const SCOPE = { tenantId: 'tenant-1' };

describe('GatewayTasksService.cancel — §7.7 local arm', () => {
  it('cancels a live task via failGatewayTask (hold released, canceled row back)', async () => {
    const row = taskRow({ status: 'running', holdAmount: 500n, accountId: 'acct-1' });
    const canceled = taskRow({ status: 'canceled' });
    const { service, queries } = serviceWith({
      getTaskByIdForTenant: vi.fn().mockResolvedValue(row),
      failGatewayTask: vi.fn().mockResolvedValue({ settled: true, task: canceled }),
    });
    const outcome = await service.cancel('task-1', SCOPE);
    expect(outcome).toEqual({ kind: 'ok', task: canceled });
    expect(queries.failGatewayTask).toHaveBeenCalledWith(expect.anything(), {
      taskId: 'task-1',
      tenantId: 'tenant-1',
      accountId: 'acct-1',
      subAccountId: null,
      holdAmount: 500n,
      to: 'canceled',
      error: null,
    });
  });

  it('a terminal (succeeded) task is NOT cancelable → conflict, no transition attempt', async () => {
    const row = taskRow({ status: 'succeeded' });
    const { service, queries } = serviceWith({
      getTaskByIdForTenant: vi.fn().mockResolvedValue(row),
    });
    const outcome = await service.cancel('task-1', SCOPE);
    expect(outcome.kind).toBe('conflict');
    expect(queries.failGatewayTask).not.toHaveBeenCalled();
  });

  it('canceling an already-canceled task is idempotent (ok)', async () => {
    const row = taskRow({ status: 'canceled' });
    const { service, queries } = serviceWith({
      getTaskByIdForTenant: vi.fn().mockResolvedValue(row),
    });
    const outcome = await service.cancel('task-1', SCOPE);
    expect(outcome.kind).toBe('ok');
    expect(queries.failGatewayTask).not.toHaveBeenCalled();
  });

  it('losing the terminal race re-reads and answers by the terminal rules', async () => {
    const live = taskRow({ status: 'running' });
    const succeeded = taskRow({ status: 'succeeded' });
    const get = vi
      .fn()
      .mockResolvedValueOnce(live) // pre-check read
      .mockResolvedValueOnce(succeeded); // post-race re-read
    const { service } = serviceWith({
      getTaskByIdForTenant: get,
      failGatewayTask: vi.fn().mockResolvedValue({ settled: false }),
    });
    const outcome = await service.cancel('task-1', SCOPE);
    expect(outcome.kind).toBe('conflict');
  });

  it('missing/unowned rows answer not_found', async () => {
    const { service } = serviceWith({});
    expect((await service.cancel('nope', SCOPE)).kind).toBe('not_found');
  });
});

describe('GatewayTasksService.get — subject isolation', () => {
  it("a subject-scoped key cannot see another subject's task", async () => {
    const row = taskRow({ subjectId: 'subj-other' });
    const { service } = serviceWith({
      getTaskByIdForTenant: vi.fn().mockResolvedValue(row),
    });
    expect(
      await service.get('task-1', { tenantId: 'tenant-1', subjectId: 'subj-9' }),
    ).toBeUndefined();
    expect(await service.get('task-1', { tenantId: 'tenant-1' })).toBe(row);
  });
});
