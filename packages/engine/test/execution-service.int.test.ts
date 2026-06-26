import type { ProviderAdapter } from '@actionow/adapters';
import { AdapterError, AdapterRegistry } from '@actionow/adapters';
import type {
  AdapterContext,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  IoSchema,
  PricebookEntry,
  SubmitInput,
  SubmitResult,
  UnifiedError,
  UsageVector,
} from '@actionow/contracts';
import { getJob, schema } from '@actionow/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { BreakerStore, RoutableChannelRef } from '../src/breaker.js';
import { EngineError } from '../src/errors.js';
import {
  ExecutionService,
  type ExecutionServiceDeps,
  type RunRequest,
} from '../src/execution-service.js';

const { account, ledgerTxn, resource, resourceVersion, tenant } = schema;

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: '../db/drizzle' });
}, 120_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

afterEach(async () => {
  await client`TRUNCATE TABLE webhook_outbox, ledger_txn, idempotency_key, job, account, resource_version, resource, tenant RESTART IDENTITY CASCADE`;
});

interface Seed {
  tenantId: string;
  accountId: string;
  resourceId: string;
}

const IO_SCHEMA: IoSchema = {
  inputs: [{ key: 'prompt', type: 'string', required: true }],
  outputs: [{ key: 'text', type: 'string' }],
};

async function seed(balance: bigint): Promise<Seed> {
  const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  const [a] = await db
    .insert(account)
    .values({ tenantId: t.id, creditBalance: balance, creditHeld: 0n })
    .returning();
  if (!a) throw new Error('account insert returned no row');
  const resourceId = 'openai';
  await db.insert(resource).values({
    id: resourceId,
    tenantId: t.id,
    kind: 'model',
    modality: 'text',
    providerType: 'fake-llm',
    execModes: ['blocking'],
  });
  await db.insert(resourceVersion).values({ resourceId, version: 1, ioSchema: IO_SCHEMA });
  return { tenantId: t.id, accountId: a.id, resourceId };
}

async function readAccount(accountId: string): Promise<{ balance: bigint; held: bigint }> {
  const [a] = await db.select().from(account).where(eq(account.id, accountId));
  if (!a) throw new Error('account not found');
  return { balance: a.creditBalance, held: a.creditHeld };
}

/** A pricebook entry with a post (unit) method: 1 µcredit per token. */
const POST_PRICEBOOK: PricebookEntry = {
  resourceId: 'openai',
  resourceVersion: 1,
  version: 1,
  method: 'unit',
  timing: 'post',
  spec: { method: 'unit', dimensions: { tokens: { rate: 1 } } },
};

/** A post (unit) pricebook for chat: 1 µcredit per OUTPUT token. */
const CHAT_PRICEBOOK: PricebookEntry = {
  resourceId: 'openai',
  resourceVersion: 1,
  version: 1,
  method: 'unit',
  timing: 'post',
  spec: { method: 'unit', dimensions: { output_tokens: { rate: 1 } } },
};

/** The neutral IR a chat run carries at `inputs.__ir`. */
const CHAT_IR: ChatRequest = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
};

/**
 * A fake chat adapter returning a fixed IR response + token usage for the
 * blocking `chat` path, and a matching `streamChat` (message_start → content →
 * usage → stop → done) so a `runChatStream` can commit + drain — the streaming
 * commit now opens the upstream during the awaited `runChatStream` (⑤-S).
 */
function fakeChatAdapter(outputTokens: number): ProviderAdapter {
  return {
    providerType: 'fake-chat',
    submit: () => Promise.resolve({ kind: 'sync', output: {}, usage: {} }),
    chat: (): Promise<ChatResponse> =>
      Promise.resolve({
        message: { role: 'assistant', content: [{ kind: 'text', text: 'echo: hi' }] },
        stopReason: 'stop',
        usage: { inputTokens: 3, outputTokens },
      }),
    // eslint-disable-next-line @typescript-eslint/require-await
    async *streamChat(): AsyncIterable<ChatStreamEvent> {
      yield { type: 'message_start' };
      yield { type: 'content_delta', text: 'echo: hi' };
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens } };
      yield { type: 'stop', stopReason: 'stop' };
      yield { type: 'done' };
    },
    extractUsage: () => ({}),
    mapError: () => ({ code: 'upstream_error', message: 'fake', retryable: false }),
  };
}

/** A `runChat` RunRequest: empty io_schema (IR rides out-of-band), holdFloor 0 (blocking). */
function chatRequest(s: Seed, overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    resource: {
      id: s.resourceId,
      version: 1,
      modality: 'text',
      ioSchema: { inputs: [], outputs: [] },
      execModes: ['blocking'],
      providerType: 'fake-chat',
    },
    pricebookEntry: CHAT_PRICEBOOK,
    modifiers: [],
    channels: [{ id: 'c1', weight: 1, credentialRef: 'ref-1', model: 'gpt' }],
    inputs: { __ir: CHAT_IR },
    execMode: 'blocking',
    tenantId: s.tenantId,
    accountId: s.accountId,
    holdFloor: 0n,
    usageLogModel: 'gpt-4o',
    ...overrides,
  };
}

/** A fake blocking LLM adapter returning a fixed text + token usage. */
function fakeLlmAdapter(usageTokens: number): ProviderAdapter {
  return {
    providerType: 'fake-llm',
    submit(input: SubmitInput): Promise<SubmitResult> {
      const prompt = input.inputs.prompt;
      return Promise.resolve({
        kind: 'sync',
        output: { text: `echo: ${String(prompt)}` },
        usage: { tokens: usageTokens },
      });
    },
    extractUsage(): UsageVector {
      return {};
    },
    mapError(): UnifiedError {
      return { code: 'upstream_error', message: 'fake', retryable: false };
    },
  };
}

function buildService(adapters: AdapterRegistry): ExecutionService {
  return new ExecutionService({
    db,
    adapters,
    resolveSecret: () => Promise.resolve('sk-secret'),
    http: { request: () => Promise.reject(new Error('http should not be called by fake adapter')) },
    now: () => new Date('2026-06-16T00:00:00.000Z'),
    enqueue: vi.fn<(jobId: string) => Promise<void>>(() => Promise.resolve()),
  });
}

function baseRequest(s: Seed, overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    resource: {
      id: s.resourceId,
      version: 1,
      modality: 'text',
      ioSchema: IO_SCHEMA,
      execModes: ['blocking'],
      providerType: 'fake-llm',
    },
    pricebookEntry: POST_PRICEBOOK,
    modifiers: [],
    channels: [{ id: 'c1', weight: 1, credentialRef: 'ref-1', model: 'gpt', endpoint: undefined }],
    inputs: { prompt: 'hi' },
    execMode: 'blocking',
    tenantId: s.tenantId,
    accountId: s.accountId,
    estimatedUsage: { tokens: 1000 },
    ...overrides,
  };
}

describe('ExecutionService.run — blocking', () => {
  it('debits the ledger by final cost and returns output on success', async () => {
    const s = await seed(1_000_000n);
    const adapters = new AdapterRegistry();
    adapters.register(fakeLlmAdapter(300));
    const svc = buildService(adapters);

    const outcome = await svc.run(baseRequest(s));

    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') throw new Error('unreachable');
    expect(outcome.output).toEqual({ text: 'echo: hi' });
    expect(outcome.usage).toEqual({ tokens: 300 });
    expect(outcome.cost.credits).toBe(300n);

    // balance debited by final cost (300), hold released to 0
    expect(await readAccount(s.accountId)).toEqual({ balance: 999_700n, held: 0n });

    // one settle ledger row with the final cost
    const ledger = await db.select().from(ledgerTxn).where(eq(ledgerTxn.jobId, outcome.jobId));
    const settleRows = ledger.filter((l) => l.type === 'settle');
    expect(settleRows).toHaveLength(1);
    expect(settleRows[0]?.creditsDelta).toBe(-300n);
    expect(settleRows[0]?.balanceAfter).toBe(999_700n);

    const job = await getJob(db, outcome.jobId);
    expect(job?.status).toBe('succeeded');
    expect(job?.costCredits).toBe(300n);
  });

  it('returns insufficient_credits and creates NO job when balance is too low', async () => {
    const s = await seed(100n); // far below the 1000-token upper-bound hold
    const adapters = new AdapterRegistry();
    adapters.register(fakeLlmAdapter(300));
    const svc = buildService(adapters);

    await expect(svc.run(baseRequest(s))).rejects.toMatchObject({
      unified: { code: 'insufficient_credits' },
    });

    // no job created, hold not placed
    const jobs = await db.select().from(schema.job);
    expect(jobs).toHaveLength(0);
    expect(await readAccount(s.accountId)).toEqual({ balance: 100n, held: 0n });
  });

  it('replays the same job for a repeated idempotency key', async () => {
    const s = await seed(1_000_000n);
    const adapters = new AdapterRegistry();
    adapters.register(fakeLlmAdapter(300));
    const svc = buildService(adapters);

    const first = await svc.run(baseRequest(s, { idempotencyKey: 'key-1' }));
    const second = await svc.run(baseRequest(s, { idempotencyKey: 'key-1' }));

    expect(second.jobId).toBe(first.jobId);

    // only one job, only one settle row → no double execution / double charge
    const jobs = await db.select().from(schema.job);
    expect(jobs).toHaveLength(1);
    const settleRows = (await db.select().from(ledgerTxn)).filter((l) => l.type === 'settle');
    expect(settleRows).toHaveLength(1);
    expect(await readAccount(s.accountId)).toEqual({ balance: 999_700n, held: 0n });
  });

  it('rejects invalid inputs with invalid_input and creates no job', async () => {
    const s = await seed(1_000_000n);
    const adapters = new AdapterRegistry();
    adapters.register(fakeLlmAdapter(300));
    const svc = buildService(adapters);

    await expect(svc.run(baseRequest(s, { inputs: {} }))).rejects.toMatchObject({
      unified: { code: 'invalid_input' },
    });

    const jobs = await db.select().from(schema.job);
    expect(jobs).toHaveLength(0);
  });

  it('fails over to the second channel when the first retryably throws', async () => {
    const s = await seed(1_000_000n);

    let attempts = 0;
    const failoverAdapter: ProviderAdapter = {
      providerType: 'fake-llm',
      submit(input: SubmitInput): Promise<SubmitResult> {
        attempts += 1;
        if (input.ctx.endpoint === 'https://a.example') {
          throw new AdapterError({
            code: 'upstream_error',
            message: 'channel A 503',
            retryable: true,
          });
        }
        return Promise.resolve({
          kind: 'sync',
          output: { text: 'from B' },
          usage: { tokens: 50 },
        });
      },
      extractUsage: () => ({}),
      mapError: () => ({ code: 'upstream_error', message: 'x', retryable: false }),
    };
    const adapters = new AdapterRegistry();
    adapters.register(failoverAdapter);
    const svc = buildService(adapters);

    const outcome = await svc.run(
      baseRequest(s, {
        channels: [
          {
            id: 'A',
            weight: 1,
            credentialRef: 'ref-a',
            model: 'gpt',
            endpoint: 'https://a.example',
          },
          {
            id: 'B',
            weight: 0,
            credentialRef: 'ref-b',
            model: 'gpt',
            endpoint: 'https://b.example',
          },
        ],
        // force the weighted pick to land on A (weight 1 vs 0) so failover -> B
      }),
    );

    expect(attempts).toBe(2);
    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') throw new Error('unreachable');
    expect(outcome.output).toEqual({ text: 'from B' });
    expect(outcome.cost.credits).toBe(50n);
  });

  it('fails the job and raises upstream_error when every channel throws', async () => {
    const s = await seed(1_000_000n);
    const alwaysFails: ProviderAdapter = {
      providerType: 'fake-llm',
      submit(): Promise<SubmitResult> {
        throw new AdapterError({ code: 'upstream_error', message: 'down', retryable: true });
      },
      extractUsage: () => ({}),
      mapError: () => ({ code: 'upstream_error', message: 'down', retryable: true }),
    };
    const adapters = new AdapterRegistry();
    adapters.register(alwaysFails);
    const svc = buildService(adapters);

    await expect(svc.run(baseRequest(s))).rejects.toBeInstanceOf(EngineError);

    // hold released by failJob → held back to 0, balance untouched
    expect(await readAccount(s.accountId)).toEqual({ balance: 1_000_000n, held: 0n });
    const jobs = await db.select().from(schema.job);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe('failed');
  });
});

describe('ExecutionService.run — channel context threading', () => {
  /**
   * Capture the AdapterContext the engine builds so we can assert proxyUrl /
   * endpoint / model / config threading. `submit` returns a trivial sync result.
   */
  function captureAdapter(seen: AdapterContext[]): ProviderAdapter {
    return {
      providerType: 'fake-llm',
      submit(input: SubmitInput): Promise<SubmitResult> {
        seen.push(input.ctx);
        return Promise.resolve({ kind: 'sync', output: { text: 'ok' }, usage: { tokens: 1 } });
      },
      extractUsage: () => ({}),
      mapError: () => ({ code: 'upstream_error', message: 'x', retryable: false }),
    };
  }

  it('threads channel proxyRef → resolved proxyUrl, plus endpoint/model/config', async () => {
    const s = await seed(1_000_000n);
    const seen: AdapterContext[] = [];
    const adapters = new AdapterRegistry();
    adapters.register(captureAdapter(seen));
    // resolveSecret maps the proxy ref to a URL and any other ref to a fake key.
    const resolveSecret = (ref: string): Promise<string | undefined> =>
      Promise.resolve(ref === 'proxy-eu' ? 'http://proxy.local:8080' : 'sk-secret');
    const svc = new ExecutionService({
      db,
      adapters,
      resolveSecret,
      http: { request: () => Promise.reject(new Error('no http')) },
      now: () => new Date('2026-06-16T00:00:00.000Z'),
      enqueue: vi.fn<(jobId: string) => Promise<void>>(() => Promise.resolve()),
    });

    await svc.run(
      baseRequest(s, {
        channels: [
          {
            id: 'c1',
            weight: 1,
            credentialRef: 'ref-1',
            model: 'gpt',
            endpoint: 'https://eu.example',
            proxyRef: 'proxy-eu',
            config: { submitPath: '/tasks', pollPath: '/tasks/{id}' },
          },
        ],
      }),
    );

    expect(seen[0]?.proxyUrl).toBe('http://proxy.local:8080');
    expect(seen[0]?.endpoint).toBe('https://eu.example');
    expect(seen[0]?.model).toBe('gpt');
    expect(seen[0]?.config).toEqual({ submitPath: '/tasks', pollPath: '/tasks/{id}' });
  });

  it('falls back to UPSTREAM_PROXY_URL when the channel has no proxyRef', async () => {
    const s = await seed(1_000_000n);
    const seen: AdapterContext[] = [];
    const adapters = new AdapterRegistry();
    adapters.register(captureAdapter(seen));
    const svc = new ExecutionService({
      db,
      adapters,
      resolveSecret: () => Promise.resolve('sk-secret'),
      http: { request: () => Promise.reject(new Error('no http')) },
      now: () => new Date('2026-06-16T00:00:00.000Z'),
      enqueue: vi.fn<(jobId: string) => Promise<void>>(() => Promise.resolve()),
      proxyUrlEnv: 'http://global-proxy.local:3128',
    });

    await svc.run(
      baseRequest(s, {
        channels: [{ id: 'c1', weight: 1, credentialRef: 'ref-1', model: 'gpt' }],
      }),
    );

    expect(seen[0]?.proxyUrl).toBe('http://global-proxy.local:3128');
  });
});

describe('ExecutionService.runChat — idempotency', () => {
  it('replays the same job for a repeated idempotency key (no double charge)', async () => {
    const s = await seed(1_000_000n);
    const adapters = new AdapterRegistry();
    adapters.register(fakeChatAdapter(5)); // 5 output tokens → 5µ
    const svc = buildService(adapters);

    const first = await svc.runChat(chatRequest(s, { idempotencyKey: 'chat-key-1' }));
    const second = await svc.runChat(chatRequest(s, { idempotencyKey: 'chat-key-1' }));

    // The replay returns the ORIGINAL job, response, and cost — not a fresh run.
    expect(second.jobId).toBe(first.jobId);
    expect(second.response).toEqual(first.response);
    expect(second.cost.credits).toBe(first.cost.credits);

    // Exactly one job and one settle row → no double execution / double charge.
    const jobs = await db.select().from(schema.job);
    expect(jobs).toHaveLength(1);
    const settleRows = (await db.select().from(ledgerTxn)).filter((l) => l.type === 'settle');
    expect(settleRows).toHaveLength(1);
    // 5 output tokens × 1µ debited exactly once.
    expect(await readAccount(s.accountId)).toEqual({ balance: 999_995n, held: 0n });
  });
});

describe('ExecutionService.runChatStream — idempotency', () => {
  it('rejects a reused idempotency key with invalid_input (cannot replay a live stream)', async () => {
    const s = await seed(1_000_000n);
    const adapters = new AdapterRegistry();
    adapters.register(fakeChatAdapter(5));
    const svc = buildService(adapters);

    // First claim succeeds (we don't need to drain the stream for the claim to persist).
    await svc.runChatStream(chatRequest(s, { execMode: 'stream', idempotencyKey: 'stream-key-1' }));

    await expect(
      svc.runChatStream(chatRequest(s, { execMode: 'stream', idempotencyKey: 'stream-key-1' })),
    ).rejects.toMatchObject({ unified: { code: 'invalid_input' } });
  });
});

/**
 * An in-memory {@link BreakerStore} double for the injection tests: `filterAvailable`
 * drops channels whose id is in `excluded`; the outcome hooks record their
 * `(id, model)` so a test can assert the engine threaded the breaker + the
 * resolved model through `routeBlocking`. Mirrors the real store's
 * fail-open/best-effort surface without Redis/PG.
 */
interface BreakerOutcome {
  id: string;
  model: string;
}
function fakeBreaker(excluded: string[] = []): BreakerStore & {
  successes: BreakerOutcome[];
  failures: BreakerOutcome[];
} {
  const successes: BreakerOutcome[] = [];
  const failures: BreakerOutcome[] = [];
  return {
    successes,
    failures,
    filterAvailable<C extends RoutableChannelRef>(channels: readonly C[]): Promise<C[]> {
      return Promise.resolve(channels.filter((c) => !excluded.includes(c.id)));
    },
    onSuccess(channelId: string, model: string): Promise<void> {
      successes.push({ id: channelId, model });
      return Promise.resolve();
    },
    onFailure(channelId: string, model: string): Promise<void> {
      failures.push({ id: channelId, model });
      return Promise.resolve();
    },
    windowStats(): Promise<null> {
      return Promise.resolve(null);
    },
  };
}

function buildServiceWith(
  adapters: AdapterRegistry,
  overrides: Partial<ExecutionServiceDeps>,
): ExecutionService {
  return new ExecutionService({
    db,
    adapters,
    resolveSecret: () => Promise.resolve('sk-secret'),
    http: { request: () => Promise.reject(new Error('no http')) },
    now: () => new Date('2026-06-16T00:00:00.000Z'),
    enqueue: vi.fn<(jobId: string) => Promise<void>>(() => Promise.resolve()),
    ...overrides,
  });
}

describe('ExecutionService — BreakerStore injection (Task 8)', () => {
  it('blocking run: does NOT attempt a channel the breaker excludes, and records onSuccess with the model', async () => {
    const s = await seed(1_000_000n);
    const attempted: string[] = [];
    const adapter: ProviderAdapter = {
      providerType: 'fake-llm',
      submit(input: SubmitInput): Promise<SubmitResult> {
        attempted.push(input.ctx.endpoint ?? '');
        return Promise.resolve({ kind: 'sync', output: { text: 'ok' }, usage: { tokens: 7 } });
      },
      extractUsage: () => ({}),
      mapError: () => ({ code: 'upstream_error', message: 'x', retryable: false }),
    };
    const adapters = new AdapterRegistry();
    adapters.register(adapter);
    const breaker = fakeBreaker(['A']);
    const svc = buildServiceWith(adapters, { breaker });

    const outcome = await svc.run(
      baseRequest(s, {
        usageLogModel: 'gpt-route',
        channels: [
          {
            id: 'A',
            weight: 1,
            credentialRef: 'ref-a',
            model: 'gpt',
            endpoint: 'https://a.example',
          },
          {
            id: 'B',
            weight: 0,
            credentialRef: 'ref-b',
            model: 'gpt',
            endpoint: 'https://b.example',
          },
        ],
      }),
    );

    expect(outcome.status).toBe('succeeded');
    // A is breaker-excluded → only B is attempted.
    expect(attempted).toEqual(['https://b.example']);
    // The success is fed back to the breaker with the resolved model.
    expect(breaker.successes).toEqual([{ id: 'B', model: 'gpt-route' }]);
    expect(breaker.failures).toEqual([]);
  });

  it('blocking run: a retryable failure on the picked channel records onFailure before failover', async () => {
    const s = await seed(1_000_000n);
    const adapter: ProviderAdapter = {
      providerType: 'fake-llm',
      submit(input: SubmitInput): Promise<SubmitResult> {
        if (input.ctx.endpoint === 'https://a.example') {
          throw new AdapterError({ code: 'upstream_error', message: '503', retryable: true });
        }
        return Promise.resolve({ kind: 'sync', output: { text: 'from B' }, usage: { tokens: 3 } });
      },
      extractUsage: () => ({}),
      mapError: () => ({ code: 'upstream_error', message: 'x', retryable: false }),
    };
    const adapters = new AdapterRegistry();
    adapters.register(adapter);
    const breaker = fakeBreaker();
    const svc = buildServiceWith(adapters, { breaker });

    await svc.run(
      baseRequest(s, {
        usageLogModel: 'gpt-route',
        channels: [
          {
            id: 'A',
            weight: 1,
            credentialRef: 'ref-a',
            model: 'gpt',
            endpoint: 'https://a.example',
          },
          {
            id: 'B',
            weight: 0,
            credentialRef: 'ref-b',
            model: 'gpt',
            endpoint: 'https://b.example',
          },
        ],
      }),
    );

    expect(breaker.failures).toEqual([{ id: 'A', model: 'gpt-route' }]);
    expect(breaker.successes).toEqual([{ id: 'B', model: 'gpt-route' }]);
  });

  it('chat run: threads the breaker + usageLogModel through runChat', async () => {
    const s = await seed(1_000_000n);
    const adapters = new AdapterRegistry();
    adapters.register(fakeChatAdapter(5));
    const breaker = fakeBreaker();
    const svc = buildServiceWith(adapters, { breaker });

    await svc.runChat(
      chatRequest(s, {
        usageLogModel: 'gpt-4o',
        channels: [{ id: 'chat-c1', weight: 1, credentialRef: 'ref-1', model: 'gpt' }],
      }),
    );

    expect(breaker.successes).toEqual([{ id: 'chat-c1', model: 'gpt-4o' }]);
  });
});

describe('ExecutionService.run — async', () => {
  it('holds, creates a queued job, enqueues, and returns {status:queued}', async () => {
    const s = await seed(1_000_000n);
    const adapters = new AdapterRegistry();
    adapters.register(fakeLlmAdapter(300));
    const enqueue = vi.fn<(jobId: string) => Promise<void>>(() => Promise.resolve());
    const svc = new ExecutionService({
      db,
      adapters,
      resolveSecret: () => Promise.resolve('sk-secret'),
      http: { request: () => Promise.reject(new Error('no http')) },
      now: () => new Date('2026-06-16T00:00:00.000Z'),
      enqueue,
    });

    const outcome = await svc.run(
      baseRequest(s, {
        execMode: 'async-poll',
        resource: {
          id: s.resourceId,
          version: 1,
          modality: 'text',
          ioSchema: IO_SCHEMA,
          execModes: ['async-poll'],
          providerType: 'fake-llm',
        },
      }),
    );

    expect(outcome.status).toBe('queued');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(outcome.jobId);

    // hold placed, job queued, nothing settled yet
    expect(await readAccount(s.accountId)).toEqual({ balance: 1_000_000n, held: 1_000n });
    const job = await getJob(db, outcome.jobId);
    expect(job?.status).toBe('queued');
    const settleRows = (await db.select().from(ledgerTxn)).filter((l) => l.type === 'settle');
    expect(settleRows).toHaveLength(0);
  });

  it('fails+releases the job when enqueue throws (no stranded queued job/hold)', async () => {
    const s = await seed(1_000_000n);
    const adapters = new AdapterRegistry();
    adapters.register(fakeLlmAdapter(300));
    // Redis is down: the enqueue rejects AFTER the hold + queued-job snapshot.
    const enqueue = vi.fn<(jobId: string) => Promise<void>>(() =>
      Promise.reject(new Error('redis unavailable')),
    );
    const svc = new ExecutionService({
      db,
      adapters,
      resolveSecret: () => Promise.resolve('sk-secret'),
      http: { request: () => Promise.reject(new Error('no http')) },
      now: () => new Date('2026-06-16T00:00:00.000Z'),
      enqueue,
    });

    await expect(
      svc.run(
        baseRequest(s, {
          execMode: 'async-poll',
          resource: {
            id: s.resourceId,
            version: 1,
            modality: 'text',
            ioSchema: IO_SCHEMA,
            execModes: ['async-poll'],
            providerType: 'fake-llm',
          },
        }),
      ),
    ).rejects.toBeDefined();

    // Hold released and the job marked failed — NOT left stranded in `queued`
    // with credits held until the 15-min reaper.
    expect(await readAccount(s.accountId)).toEqual({ balance: 1_000_000n, held: 0n });
    const jobs = await db.select().from(schema.job);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe('failed');
  });
});
