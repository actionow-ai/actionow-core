// 批次4 slice3 — shared unit-test fixtures for the gateway controllers: a
// fake express Request/Response pair, the guard-attached ApiKeyContext, a
// SupplyModelRow and TaskRow factory. NO database, NO Nest Test harness —
// controllers are instantiated directly (the console.guard.test 范式).
import type { SupplyModelRow, TaskRow } from '@actionow/db';
import type { Request, Response } from 'express';

import type { ApiKeyContext } from '../src/auth/api-key.guard.js';

export const AUTH: ApiKeyContext = {
  tenantId: 'tenant-1',
  accountId: 'acct-1',
  apiKeyId: 'key-1',
  resourceAllowlist: [],
  rateLimit: null,
  routeGroupId: null,
  limitPlanId: null,
  tenantLimitPlanId: null,
  subjectId: null,
  subjectLimitPlanId: null,
};

/** A fake authed request; override headers/auth per test. */
export function fakeReq(
  overrides: { auth?: ApiKeyContext | undefined; headers?: Record<string, string> } = {},
): Request {
  return {
    headers: overrides.headers ?? {},
    auth: 'auth' in overrides ? overrides.auth : AUTH,
  } as unknown as Request;
}

export interface FakeRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  chunks: string[];
  writableEnded: boolean;
  status(code: number): FakeRes;
  json(body: unknown): FakeRes;
  setHeader(key: string, value: string | number): void;
  getHeader(key: string): string | undefined;
  flushHeaders(): void;
  write(chunk: string): boolean;
  end(): void;
  on(event: string, cb: () => void): void;
}

/** A minimal express Response double capturing status/headers/body/SSE chunks. */
export function fakeRes(): FakeRes & Response {
  const res: FakeRes = {
    statusCode: 200,
    body: undefined,
    headers: {},
    chunks: [],
    writableEnded: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = String(value);
    },
    getHeader(key) {
      return this.headers[key.toLowerCase()];
    },
    flushHeaders() {
      /* noop */
    },
    write(chunk) {
      this.chunks.push(chunk);
      return true;
    },
    end() {
      this.writableEnded = true;
    },
    on() {
      /* noop */
    },
  };
  return res as FakeRes & Response;
}

/** A video-generation supply model with a small canonical contract. */
export function modelRow(overrides: Partial<SupplyModelRow> = {}): SupplyModelRow {
  return {
    id: 'model-1',
    name: 'seedance-pro',
    displayName: 'Seedance Pro',
    icon: null,
    status: 'active',
    modality: 'video',
    operations: [
      {
        operation: 'video.generation',
        paradigms: ['task'],
        slow: false,
        params: [
          { name: 'prompt', type: 'string', billingRelevant: false, required: true },
          {
            name: 'resolution',
            type: 'enum',
            billingRelevant: true,
            required: false,
            default: '720p',
            values: ['720p', '1080p'],
          },
        ],
      },
      {
        operation: 'images.generation',
        paradigms: ['sync', 'task'],
        slow: true,
        params: [{ name: 'prompt', type: 'string', billingRelevant: false, required: true }],
      },
    ],
    capabilities: [],
    priceCardId: 'pc-1',
    modifierGroupId: null,
    maxRunTimeSeconds: 600,
    artifact: { mode: 'signed', retention_days: null },
    fallbackModelIds: [],
    limitPlanId: null,
    visibility: 'public',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  };
}

/** A task row in `pending` unless overridden. */
export function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'task-1',
    tenantId: 'tenant-1',
    apiKeyId: 'key-1',
    subjectId: null,
    operation: 'video.generation',
    modelId: 'model-1',
    offeringId: 'offering-1',
    status: 'pending',
    internalSubstate: null,
    progress: null,
    fetchMode: 'submit_poll',
    upstreamTaskId: null,
    ownerNode: null,
    leaseUntil: null,
    maxRunTimeSeconds: 600,
    holdExpiresAt: null,
    holdAmount: 0n,
    accountId: 'acct-1',
    subAccountId: null,
    estimated: false,
    saleCardRef: null,
    costCardRef: null,
    artifactMode: 'signed',
    artifactExpiresAt: null,
    requestFingerprint: null,
    idempotencyKey: null,
    callbackUrl: null,
    inputs: { model: 'seedance-pro' },
    output: null,
    usage: null,
    error: null,
    createdAt: new Date('2026-07-10T00:00:00Z'),
    updatedAt: new Date('2026-07-10T00:00:00Z'),
    startedAt: null,
    finishedAt: null,
    deletedAt: null,
    ...overrides,
  };
}
