// apps/api/src/gateway/tasks.service.ts
//
// model-supply-greenfield 批次4 slice3 — the /v1/tasks read/cancel surface
// over the slice1 task repos. Tenant isolation is the REPO's SQL predicate
// (getTaskByIdForTenant / listTasks); a subject-scoped key additionally sees
// only ITS OWN tasks (the jobs-list precedent). Cancel is the §7.7 LOCAL arm:
// guarded terminal transition + hold release via failGatewayTask — the
// upstream cancel forward is slice4; 晚到结果丢弃 holds by construction
// because every later settle/callback runs through the transitionTask
// from-guard, which never leaves a terminal state.
import type { TaskStatus } from '@actionow/contracts';
import { TERMINAL_TASK_STATUSES } from '@actionow/contracts';
import type { Database, KeysetResult, PageParams, TaskEventRow, TaskRow } from '@actionow/db';
import { failGatewayTask, getTaskByIdForTenant, listTaskEvents, listTasks } from '@actionow/db';
import { emitTaskWebhookBestEffort } from '@actionow/engine';
import { Inject, Injectable } from '@nestjs/common';

import { DB } from '../common/tokens.js';

/** The caller scope every read/cancel is pinned to. */
export interface TaskScope {
  tenantId: string;
  /** Set for a subject-scoped key — reads narrow to this subject's tasks. */
  subjectId?: string | undefined;
}

/** Optional list filters (§5: GET /v1/tasks?status=&type=). */
export interface TaskListFilter {
  status?: TaskStatus | undefined;
  operation?: string | undefined;
}

export type CancelOutcome =
  | { kind: 'ok'; task: TaskRow }
  | { kind: 'not_found' }
  /** Already terminal (and not `canceled`) — not cancelable (409). */
  | { kind: 'conflict'; task: TaskRow };

/** The repo surface, injectable for unit tests. */
export interface TaskQueries {
  getTaskByIdForTenant: typeof getTaskByIdForTenant;
  listTasks: typeof listTasks;
  listTaskEvents: typeof listTaskEvents;
  failGatewayTask: typeof failGatewayTask;
}

const DEFAULT_QUERIES: TaskQueries = {
  getTaskByIdForTenant,
  listTasks,
  listTaskEvents,
  failGatewayTask,
};

const TERMINAL: readonly string[] = TERMINAL_TASK_STATUSES;

@Injectable()
export class GatewayTasksService {
  private readonly queries: TaskQueries;

  constructor(@Inject(DB) private readonly db: Database) {
    this.queries = DEFAULT_QUERIES;
  }

  /** Tenant- (and subject-) isolated single read; `undefined` → 404. */
  async get(id: string, scope: TaskScope): Promise<TaskRow | undefined> {
    const row = await this.queries.getTaskByIdForTenant(this.db, id, scope.tenantId);
    if (row === undefined) return undefined;
    // A subject-scoped key sees ONLY its own subject's tasks — an unowned task
    // is indistinguishable from a missing one (the jobs-isolation precedent).
    if (scope.subjectId !== undefined && row.subjectId !== scope.subjectId) return undefined;
    return row;
  }

  /** Tenant list, newest-first keyset (§5 游标分页). */
  list(scope: TaskScope, filter: TaskListFilter, page: PageParams): Promise<KeysetResult<TaskRow>> {
    return this.queries.listTasks(
      this.db,
      {
        tenantId: scope.tenantId,
        ...(scope.subjectId !== undefined ? { subjectId: scope.subjectId } : {}),
        ...(filter.status !== undefined ? { status: filter.status } : {}),
        ...(filter.operation !== undefined ? { operation: filter.operation } : {}),
      },
      page,
    );
  }

  /** The task's event stream after `afterSeq` (SSE catch-up reads). */
  events(taskId: string, afterSeq: number): Promise<TaskEventRow[]> {
    return this.queries.listTaskEvents(this.db, taskId, afterSeq);
  }

  /**
   * §7.7 local cancel: `pending|running → canceled` + hold release, NO charge
   * (费用已产生的照常计量在 settle 侧 — a task that already settled is terminal
   * and lands in the conflict arm). Idempotent: canceling a `canceled` task
   * answers 200 with the row; any OTHER terminal state answers 409.
   */
  async cancel(id: string, scope: TaskScope): Promise<CancelOutcome> {
    const row = await this.get(id, scope);
    if (row === undefined) return { kind: 'not_found' };
    if (TERMINAL.includes(row.status)) {
      return row.status === 'canceled'
        ? { kind: 'ok', task: row }
        : { kind: 'conflict', task: row };
    }
    const failed = await this.queries.failGatewayTask(this.db, {
      taskId: row.id,
      tenantId: scope.tenantId,
      accountId: row.accountId,
      subAccountId: row.subAccountId,
      holdAmount: row.holdAmount ?? 0n,
      to: 'canceled',
      error: null,
    });
    if (failed.settled && failed.task !== undefined) {
      // §7.6 'task.canceled' envelope — best-effort, only when the cancel
      // actually moved the row (the winner emits; deterministic evt_id
      // dedupes a racing failGatewayResult cancel).
      await emitTaskWebhookBestEffort({ db: this.db }, failed.task, 'task.canceled');
      return { kind: 'ok', task: failed.task };
    }
    // Lost the race to a terminal writer between read and transition —
    // re-read and answer by the SAME terminal rules.
    const current = await this.get(id, scope);
    if (current === undefined) return { kind: 'not_found' };
    return current.status === 'canceled'
      ? { kind: 'ok', task: current }
      : { kind: 'conflict', task: current };
  }
}
