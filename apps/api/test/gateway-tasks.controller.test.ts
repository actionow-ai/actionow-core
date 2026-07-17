// 批次4 slice3 — GatewayTasksController unit tests (mocked services): 404
// task_not_found + tenant/subject scoping, the cancel state machine (200 /
// 409 conflict / idempotent canceled), the list envelope + filter validation.
import { describe, expect, it, vi } from 'vitest';

import type { GatewayTaskStreamService } from '../src/gateway/task-stream.service.js';
import { GatewayTasksController } from '../src/gateway/tasks.controller.js';
import type { CancelOutcome, GatewayTasksService } from '../src/gateway/tasks.service.js';
import { AUTH, fakeReq, fakeRes, taskRow } from './gateway-fixtures.js';

interface TasksStub {
  get: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  events: ReturnType<typeof vi.fn>;
}

function controllerWith(stub: Partial<TasksStub> = {}): {
  controller: GatewayTasksController;
  tasks: TasksStub;
  stream: { streamTo: ReturnType<typeof vi.fn> };
} {
  const tasks: TasksStub = {
    get: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ rows: [], hasMore: false }),
    cancel: vi.fn(),
    events: vi.fn().mockResolvedValue([]),
    ...stub,
  };
  const stream = { streamTo: vi.fn().mockResolvedValue(undefined) };
  return {
    controller: new GatewayTasksController(
      tasks as unknown as GatewayTasksService,
      stream as unknown as GatewayTaskStreamService,
    ),
    tasks,
    stream,
  };
}

describe('GET /v1/tasks/:id', () => {
  it('renders the Task view for an owned task', async () => {
    const { controller, tasks } = controllerWith({
      get: vi.fn().mockResolvedValue(taskRow({ status: 'running', progress: 40 })),
    });
    const res = fakeRes();
    const body = await controller.get('task-1', fakeReq(), res);
    expect(body).toMatchObject({
      id: 'task-1',
      object: 'task',
      status: 'running',
      progress: 40,
      served_by: { offering_id: 'offering-1' },
    });
    // tenant scope came from the guard context
    expect(tasks.get).toHaveBeenCalledWith('task-1', { tenantId: 'tenant-1' });
  });

  it('404 task_not_found when the row is missing/unowned', async () => {
    const { controller } = controllerWith();
    const res = fakeRes();
    await controller.get('nope', fakeReq(), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: { code: 'task_not_found' } });
  });

  it('a subject-scoped key narrows the read scope to its subject', async () => {
    const { controller, tasks } = controllerWith();
    const res = fakeRes();
    await controller.get('task-1', fakeReq({ auth: { ...AUTH, subjectId: 'subj-9' } }), res);
    expect(tasks.get).toHaveBeenCalledWith('task-1', {
      tenantId: 'tenant-1',
      subjectId: 'subj-9',
    });
  });
});

describe('GET /v1/tasks (list)', () => {
  it('returns the keyset envelope of Task views', async () => {
    const rows = [taskRow(), taskRow({ id: 'task-2', status: 'succeeded' })];
    const { controller, tasks } = controllerWith({
      list: vi.fn().mockResolvedValue({ rows, hasMore: false }),
    });
    const res = fakeRes();
    const body = (await controller.list(fakeReq(), res, 'pending', 'video.generation')) as {
      data: { id: string; object: string }[];
      has_more: boolean;
      next_cursor: string | null;
    };
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toMatchObject({ id: 'task-1', object: 'task' });
    expect(body.has_more).toBe(false);
    expect(body.next_cursor).toBeNull();
    expect(tasks.list).toHaveBeenCalledWith(
      { tenantId: 'tenant-1' },
      { status: 'pending', operation: 'video.generation' },
      { limit: 50 },
    );
  });

  it('rejects an unknown status filter (400 invalid_input)', async () => {
    const { controller, tasks } = controllerWith();
    const res = fakeRes();
    await controller.list(fakeReq(), res, 'sleeping');
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'invalid_input' } });
    expect(tasks.list).not.toHaveBeenCalled();
  });

  it('rejects an unknown type filter (400 invalid_input)', async () => {
    const { controller, tasks } = controllerWith();
    const res = fakeRes();
    await controller.list(fakeReq(), res, undefined, 'video.wat');
    expect(res.statusCode).toBe(400);
    expect(tasks.list).not.toHaveBeenCalled();
  });
});

describe('POST /v1/tasks/:id/cancel', () => {
  it('200 + the canceled Task on success', async () => {
    const outcome: CancelOutcome = { kind: 'ok', task: taskRow({ status: 'canceled' }) };
    const { controller } = controllerWith({ cancel: vi.fn().mockResolvedValue(outcome) });
    const res = fakeRes();
    const body = await controller.cancel('task-1', fakeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({ status: 'canceled' });
  });

  it('409 conflict when the task is already terminal (non-canceled)', async () => {
    const outcome: CancelOutcome = { kind: 'conflict', task: taskRow({ status: 'succeeded' }) };
    const { controller } = controllerWith({ cancel: vi.fn().mockResolvedValue(outcome) });
    const res = fakeRes();
    await controller.cancel('task-1', fakeReq(), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({
      error: { code: 'conflict', details: { status: 'succeeded' } },
    });
  });

  it('404 when the task is missing/unowned', async () => {
    const outcome: CancelOutcome = { kind: 'not_found' };
    const { controller } = controllerWith({ cancel: vi.fn().mockResolvedValue(outcome) });
    const res = fakeRes();
    await controller.cancel('nope', fakeReq(), res);
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /v1/tasks/:id/stream', () => {
  it('404s BEFORE any SSE byte when the task is unowned', async () => {
    const { controller, stream } = controllerWith();
    const res = fakeRes();
    await controller.streamTask('nope', fakeReq(), res);
    expect(res.statusCode).toBe(404);
    expect(stream.streamTo).not.toHaveBeenCalled();
    expect(res.chunks).toHaveLength(0);
  });

  it('hands the authorized snapshot to the stream service', async () => {
    const row = taskRow({ status: 'running' });
    const { controller, stream } = controllerWith({ get: vi.fn().mockResolvedValue(row) });
    const res = fakeRes();
    await controller.streamTask('task-1', fakeReq(), res);
    expect(stream.streamTo).toHaveBeenCalledWith(res, row, { tenantId: 'tenant-1' });
  });
});
