// 批次4 slice4 — §7.6 webhook envelope + dispatcher tests: evt_id + full Task
// envelope, HMAC-with-timestamp signing verifiable over the SENT bytes, the
// FIXED five-slot backoff ladder, dead-letter past it, (task_id, evt_id)
// send-side idempotency, and SSRF dead-lettering.
import type { HttpClient, HttpResponse } from '@actionow/contracts';
import type { WebhookDeliveryRow } from '@actionow/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDeliveryMock, listDueMock, markSentMock, markDeadMock, rescheduleMock } = vi.hoisted(
  () => ({
    createDeliveryMock: vi.fn(),
    listDueMock: vi.fn(),
    markSentMock: vi.fn(),
    markDeadMock: vi.fn(),
    rescheduleMock: vi.fn(),
  }),
);

vi.mock('@actionow/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createWebhookDelivery: createDeliveryMock,
    listDueWebhookDeliveries: listDueMock,
    markWebhookDeliverySent: markSentMock,
    markWebhookDeliveryDead: markDeadMock,
    rescheduleWebhookDelivery: rescheduleMock,
  };
});

import type { DbOrTx } from '@actionow/db';

import {
  buildTaskWebhookEnvelope,
  emitTaskWebhookBestEffort,
  emitTaskWebhookEvent,
  signTaskWebhook,
  TASK_WEBHOOK_BACKOFF_LADDER_MS,
  TASK_WEBHOOK_EVENT_HEADER,
  TASK_WEBHOOK_SIGNATURE_HEADER,
  TaskWebhookDispatcher,
  taskWebhookEvtId,
  verifyTaskWebhookSignature,
} from '../../src/index.js';
import { NOW, taskRowOf } from './gateway-fixtures.js';

const DB = {} as DbOrTx;

function deliveryRow(over: Partial<WebhookDeliveryRow> = {}): WebhookDeliveryRow {
  return {
    id: 'del-1',
    taskId: 'task-1',
    evtId: 'evt_task-1_succeeded',
    eventType: 'task.succeeded',
    url: 'https://consumer.example/hook',
    payload: { evt_id: 'evt_task-1_succeeded', event_type: 'task.succeeded', hello: 'world' },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: NOW,
    signature: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

interface SentRequest {
  url: string;
  headers: Record<string, string> | undefined;
  body: unknown;
}

function httpOf(script: { ok?: boolean; throws?: boolean } = {}): {
  http: HttpClient;
  sent: SentRequest[];
} {
  const sent: SentRequest[] = [];
  const http: HttpClient = {
    request(req): Promise<HttpResponse> {
      sent.push({ url: req.url, headers: req.headers, body: req.body });
      if (script.throws === true) return Promise.reject(new Error('network down'));
      const ok = script.ok ?? true;
      return Promise.resolve({ status: ok ? 200 : 500, ok, body: null, text: '' });
    },
  };
  return { http, sent };
}

beforeEach(() => {
  createDeliveryMock.mockReset().mockResolvedValue(deliveryRow());
  listDueMock.mockReset().mockResolvedValue([]);
  markSentMock.mockReset().mockResolvedValue(undefined);
  markDeadMock.mockReset().mockResolvedValue(undefined);
  rescheduleMock.mockReset().mockResolvedValue(undefined);
});

// --- envelope (§7.6 事件信封) ----------------------------------------------------------

describe('task webhook envelope', () => {
  it('carries evt_id + event_type + the COMPLETE external Task body', () => {
    const task = taskRowOf({
      id: 'task-9',
      status: 'succeeded',
      operation: 'video.generation',
      offeringId: 'off-1',
      output: { url: 'https://cdn.example/v.mp4' },
      inputs: { model: 'video-model' },
      callbackUrl: 'https://consumer.example/hook',
      finishedAt: NOW,
    });
    const envelope = buildTaskWebhookEnvelope(task, 'task.succeeded', NOW);
    expect(envelope.evt_id).toBe('evt_task-9_succeeded');
    expect(envelope.event_type).toBe('task.succeeded');
    expect(envelope.created_at).toBe(NOW.toISOString());
    // The FULL §5 Task projection — external shape, no internal columns.
    expect(envelope.task).toMatchObject({
      id: 'task-9',
      object: 'task',
      type: 'video.generation',
      model: 'video-model',
      status: 'succeeded',
      output: { url: 'https://cdn.example/v.mp4' },
      served_by: { offering_id: 'off-1' },
    });
    expect(envelope.task).not.toHaveProperty('holdAmount');
    expect(envelope.task).not.toHaveProperty('leaseUntil');
  });

  it('evt_id is deterministic per logical event; progress keys by value', () => {
    expect(taskWebhookEvtId('t1', 'task.succeeded')).toBe(taskWebhookEvtId('t1', 'task.succeeded'));
    expect(taskWebhookEvtId('t1', 'task.progress', 40)).toBe('evt_t1_progress_40');
    expect(taskWebhookEvtId('t1', 'task.progress', 41)).not.toBe(
      taskWebhookEvtId('t1', 'task.progress', 40),
    );
  });

  it('emit enqueues one delivery keyed (task_id, evt_id); no callback_url → no-op', async () => {
    const task = taskRowOf({ id: 'task-9', callbackUrl: 'https://consumer.example/hook' });
    await emitTaskWebhookEvent(DB, task, 'task.succeeded', NOW);
    expect(createDeliveryMock).toHaveBeenCalledOnce();
    expect(createDeliveryMock.mock.calls[0]?.[1]).toMatchObject({
      taskId: 'task-9',
      evtId: 'evt_task-9_succeeded',
      eventType: 'task.succeeded',
      url: 'https://consumer.example/hook',
      signature: null, // signing is DISPATCH-time (jsonb round-trip safety)
    });

    createDeliveryMock.mockClear();
    await emitTaskWebhookEvent(DB, taskRowOf({ callbackUrl: null }), 'task.succeeded', NOW);
    expect(createDeliveryMock).not.toHaveBeenCalled();
  });

  it('best-effort emission swallows enqueue failures (不入钱路)', async () => {
    createDeliveryMock.mockRejectedValue(new Error('db down'));
    const task = taskRowOf({ callbackUrl: 'https://consumer.example/hook' });
    await expect(
      emitTaskWebhookBestEffort({ db: DB }, task, 'task.failed'),
    ).resolves.toBeUndefined();
  });
});

// --- HMAC with timestamp (§7.6) --------------------------------------------------------

describe('HMAC-with-timestamp signature', () => {
  it('signs t=<ts>,v1=<hex> and round-trips through verify', () => {
    const header = signTaskWebhook('whsec_test', '{"a":1}', 1_752_000_000);
    expect(header).toMatch(/^t=1752000000,v1=[0-9a-f]{64}$/);
    expect(
      verifyTaskWebhookSignature('whsec_test', '{"a":1}', header, { nowSeconds: 1_752_000_010 }),
    ).toBe(true);
  });

  it('rejects a tampered body, a wrong secret, and a stale timestamp', () => {
    const header = signTaskWebhook('whsec_test', '{"a":1}', 1_752_000_000);
    expect(
      verifyTaskWebhookSignature('whsec_test', '{"a":2}', header, { nowSeconds: 1_752_000_010 }),
    ).toBe(false);
    expect(
      verifyTaskWebhookSignature('whsec_other', '{"a":1}', header, { nowSeconds: 1_752_000_010 }),
    ).toBe(false);
    expect(
      verifyTaskWebhookSignature('whsec_test', '{"a":1}', header, { nowSeconds: 1_752_009_999 }),
    ).toBe(false);
  });
});

// --- dispatcher (worker sweep) ----------------------------------------------------------

describe('TaskWebhookDispatcher', () => {
  const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

  function dispatcher(o: { secret?: string; egressBlocked?: boolean } = {}): TaskWebhookDispatcher {
    return new TaskWebhookDispatcher({
      resolveSecret: () => Promise.resolve(o.secret),
      assertEgressAllowed: () =>
        o.egressBlocked === true ? Promise.reject(new Error('blocked')) : Promise.resolve(),
      nowSeconds: () => NOW_SECONDS,
    });
  }

  it('delivers with a FRESH timestamped signature verifiable over the SENT bytes', async () => {
    const row = deliveryRow();
    listDueMock.mockResolvedValue([row]);
    const { http, sent } = httpOf();

    const summary = await dispatcher({ secret: 'whsec_test' }).dispatchDue(DB, http, NOW);

    expect(summary).toMatchObject({ processed: 1, sent: 1, retried: 0, dead: 0 });
    expect(markSentMock).toHaveBeenCalledWith(DB, 'del-1', 1);
    const req = sent[0];
    expect(req?.headers?.[TASK_WEBHOOK_EVENT_HEADER]).toBe('task.succeeded');
    const signature = req?.headers?.[TASK_WEBHOOK_SIGNATURE_HEADER] ?? '';
    // The signature verifies over EXACTLY what was serialized onto the wire.
    expect(
      verifyTaskWebhookSignature('whsec_test', JSON.stringify(req?.body), signature, {
        nowSeconds: NOW_SECONDS,
      }),
    ).toBe(true);
  });

  it('delivers unsigned when the tenant has no webhook secret', async () => {
    listDueMock.mockResolvedValue([deliveryRow()]);
    const { http, sent } = httpOf();
    await dispatcher({}).dispatchDue(DB, http, NOW);
    expect(sent[0]?.headers?.[TASK_WEBHOOK_SIGNATURE_HEADER]).toBeUndefined();
    expect(markSentMock).toHaveBeenCalled();
  });

  it('walks the FIXED five-slot ladder 5s/30s/2m/10m/1h on repeated failure', async () => {
    const { http } = httpOf({ ok: false });
    const d = dispatcher({});
    for (let attempts = 0; attempts < 5; attempts++) {
      rescheduleMock.mockClear();
      listDueMock.mockResolvedValue([deliveryRow({ attempts })]);
      const summary = await d.dispatchDue(DB, http, NOW);
      expect(summary.retried).toBe(1);
      const [, , nextAttempts, nextAt] = rescheduleMock.mock.calls[0] as [
        unknown,
        string,
        number,
        Date,
      ];
      expect(nextAttempts).toBe(attempts + 1);
      expect(nextAt.getTime() - NOW.getTime()).toBe(TASK_WEBHOOK_BACKOFF_LADDER_MS[attempts]);
    }
    expect(TASK_WEBHOOK_BACKOFF_LADDER_MS).toEqual([5_000, 30_000, 120_000, 600_000, 3_600_000]);
  });

  it('dead-letters past the ladder and never delivers a dead row again', async () => {
    // 5 failed attempts already recorded → the 6th failure dead-letters.
    listDueMock.mockResolvedValue([deliveryRow({ attempts: 5 })]);
    const { http, sent } = httpOf({ ok: false });
    const summary = await dispatcher({}).dispatchDue(DB, http, NOW);
    expect(summary.dead).toBe(1);
    expect(markDeadMock).toHaveBeenCalledWith(DB, 'del-1', 6);
    expect(rescheduleMock).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);

    // Dead rows leave the due feed (status filter) — the next sweep sends nothing.
    listDueMock.mockResolvedValue([]);
    const again = await dispatcher({}).dispatchDue(DB, http, NOW);
    expect(again.processed).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('an SSRF-blocked url dead-letters immediately without a request', async () => {
    listDueMock.mockResolvedValue([deliveryRow({ url: 'http://169.254.169.254/latest' })]);
    const { http, sent } = httpOf();
    const summary = await dispatcher({ egressBlocked: true }).dispatchDue(DB, http, NOW);
    expect(summary.dead).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it('a network throw is a plain delivery failure (rescheduled, not dead)', async () => {
    listDueMock.mockResolvedValue([deliveryRow({ attempts: 0 })]);
    const { http } = httpOf({ throws: true });
    const summary = await dispatcher({}).dispatchDue(DB, http, NOW);
    expect(summary.retried).toBe(1);
  });
});
