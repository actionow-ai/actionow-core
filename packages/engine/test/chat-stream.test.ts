import type { ProviderAdapter } from '@actionow/adapters';
import { AdapterError, AdapterRegistry } from '@actionow/adapters';
import type {
  AdapterContext,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  HttpClient,
  PricebookEntry,
} from '@actionow/contracts';
import type { DbOrTx } from '@actionow/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExecutionService, type RunRequest } from '../src/execution-service.js';
import { createChatSettlingStream } from '../src/stream.js';

// Record settle/fail/usage-log calls without a DB: the chat settling stream
// calls these module-level repo functions, so we replace them with fakes here.
const settleCalls: { usage: unknown; finalCost: bigint }[] = [];

/** Captured AdapterContext from {@link captureAdapter} — reset in beforeEach. */
let capturedCtx: AdapterContext | undefined;
const failCalls: { error: unknown }[] = [];
const usageLogCalls: {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  channelId?: string;
  providerType?: string;
}[] = [];

vi.mock('@actionow/db', () => ({
  settleJob: vi.fn((_db: unknown, p: { usage: unknown; finalCost: bigint }) => {
    settleCalls.push({ usage: p.usage, finalCost: p.finalCost });
    return Promise.resolve({ settled: true });
  }),
  failJob: vi.fn((_db: unknown, p: { error: unknown }) => {
    failCalls.push({ error: p.error });
    return Promise.resolve({ settled: true });
  }),
  insertUsageLog: vi.fn(
    (
      _db: unknown,
      p: {
        model: string;
        inputTokens?: number;
        outputTokens?: number;
        channelId?: string;
        providerType?: string;
      },
    ) => {
      const entry: {
        model: string;
        inputTokens?: number;
        outputTokens?: number;
        channelId?: string;
        providerType?: string;
      } = {
        model: p.model,
      };
      if (p.inputTokens !== undefined) entry.inputTokens = p.inputTokens;
      if (p.outputTokens !== undefined) entry.outputTokens = p.outputTokens;
      if (p.channelId !== undefined) entry.channelId = p.channelId;
      if (p.providerType !== undefined) entry.providerType = p.providerType;
      usageLogCalls.push(entry);
      return Promise.resolve({});
    },
  ),
  // Enough of the hold/create surface for runChatStream's validateAndHold prefix.
  holdCredits: vi.fn(() => Promise.resolve(true)),
  createJob: vi.fn((_db: unknown, p: { id: string }) => Promise.resolve({ id: p.id })),
  claimIdempotency: vi.fn(() => Promise.resolve({ claimed: true })),
  getJob: vi.fn(() => Promise.resolve(undefined)),
  // Channel-routing health: single-channel tests never query/record, but the
  // mock must provide them so the rewired runChat/streamChat paths resolve.
  listCooledDownChannelIds: vi.fn(() => Promise.resolve([])),
  recordChannelFailure: vi.fn(() => Promise.resolve()),
}));

beforeEach(() => {
  settleCalls.length = 0;
  failCalls.length = 0;
  usageLogCalls.length = 0;
  capturedCtx = undefined;
});

const FAKE_DB = {} as DbOrTx;
const FAKE_HTTP: HttpClient = {
  request: () => Promise.reject(new Error('http should not be called')),
};

/** A post (unit) pricebook: 1 µcredit per output_token → usage 2 → 2µ. */
const POST_PRICEBOOK: PricebookEntry = {
  resourceId: 'chat-resource',
  resourceVersion: 1,
  version: 1,
  method: 'unit',
  timing: 'post',
  spec: { method: 'unit', dimensions: { output_tokens: { rate: 1 } } },
};

const IR: ChatRequest = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
};

/** A fake chat adapter: message_start → content_delta → usage → stop → done. */
function fakeChatAdapter(): ProviderAdapter {
  return {
    providerType: 'mock-chat',
    submit: () => Promise.resolve({ kind: 'sync', output: {}, usage: {} }),
    chat: (): Promise<ChatResponse> =>
      Promise.resolve({
        message: { role: 'assistant', content: [{ kind: 'text', text: 'ok' }] },
        stopReason: 'stop',
        usage: { inputTokens: 3, outputTokens: 2 },
      }),
    // eslint-disable-next-line @typescript-eslint/require-await
    async *streamChat(): AsyncIterable<ChatStreamEvent> {
      yield { type: 'message_start' };
      yield { type: 'content_delta', text: 'ok' };
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } };
      yield { type: 'stop', stopReason: 'stop' };
      yield { type: 'done' };
    },
    extractUsage: () => ({}),
    mapError: () => ({ code: 'upstream_error', message: 'mock', retryable: false }),
  };
}

/** A chat adapter that streams content but NO usage frame (provider omits it). */
function fakeChatAdapterNoUsage(): ProviderAdapter {
  return {
    ...fakeChatAdapter(),
    // eslint-disable-next-line @typescript-eslint/require-await
    async *streamChat(): AsyncIterable<ChatStreamEvent> {
      yield { type: 'message_start' };
      yield { type: 'content_delta', text: 'ok' };
      yield { type: 'stop', stopReason: 'stop' };
      yield { type: 'done' };
    },
  };
}

/** A chat adapter that streams content then yields a mid-stream IR error event. */
function fakeChatAdapterError(): ProviderAdapter {
  return {
    ...fakeChatAdapter(),
    // eslint-disable-next-line @typescript-eslint/require-await
    async *streamChat(): AsyncIterable<ChatStreamEvent> {
      yield { type: 'message_start' };
      yield { type: 'content_delta', text: 'ok' };
      yield { type: 'error', error: { code: 'upstream_error', message: 'boom', retryable: false } };
    },
  };
}

/**
 * A chat adapter whose streamChat fails with a RETRYABLE first-frame error for a
 * channel routed with model 'bad', and streams a normal completion otherwise —
 * exercises pre-first-event channel failover (the channel is chosen by ctx.model).
 */
function fakeFailoverChatAdapter(): ProviderAdapter {
  return {
    ...fakeChatAdapter(),
    // eslint-disable-next-line @typescript-eslint/require-await
    async *streamChat(_ir: ChatRequest, ctx: AdapterContext): AsyncIterable<ChatStreamEvent> {
      if (ctx.model === 'bad') {
        yield { type: 'error', error: { code: 'rate_limited', message: '429', retryable: true } };
        return;
      }
      yield { type: 'message_start' };
      yield { type: 'content_delta', text: 'ok' };
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } };
      yield { type: 'stop', stopReason: 'stop' };
      yield { type: 'done' };
    },
  };
}

/**
 * A capture adapter (providerType `capture`) whose `chat` records the
 * {@link AdapterContext} it receives so callers can assert on it.
 */
function captureAdapter(): ProviderAdapter {
  return {
    ...fakeChatAdapter(),
    providerType: 'capture',
    chat: (ir: ChatRequest, ctx: AdapterContext): Promise<ChatResponse> => {
      capturedCtx = ctx;
      return Promise.resolve({
        message: { role: 'assistant', content: [{ kind: 'text', text: 'ok' }] },
        stopReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    },
  };
}

/**
 * A second chat adapter (providerType `openai-fail`) whose blocking `chat`
 * always throws a RETRYABLE {@link AdapterError} — used to prove per-channel
 * adapter selection + cross-provider failover on the blocking `runChat` path.
 */
function failingChatAdapter(): ProviderAdapter {
  return {
    providerType: 'openai-fail',
    submit: () => Promise.resolve({ kind: 'sync', output: {}, usage: {} }),
    chat: (): Promise<ChatResponse> => {
      throw new AdapterError({ code: 'rate_limited', message: 'x', retryable: true });
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async *streamChat(): AsyncIterable<ChatStreamEvent> {
      yield { type: 'error', error: { code: 'rate_limited', message: 'x', retryable: true } };
    },
    extractUsage: () => ({}),
    mapError: () => ({ code: 'upstream_error', message: 'mock', retryable: false }),
  };
}

function deps(
  overrides: Partial<RunRequest> = {},
  adapter: ProviderAdapter = fakeChatAdapter(),
): Parameters<typeof createChatSettlingStream>[0] {
  const adapters = new AdapterRegistry();
  adapters.register(adapter);
  return depsWith(adapters, overrides);
}

/** Same as {@link deps} but with a caller-supplied registry (multi-adapter). */
function depsWith(
  adapters: AdapterRegistry,
  overrides: Partial<RunRequest> = {},
): Parameters<typeof createChatSettlingStream>[0] {
  const req: RunRequest = {
    resource: {
      id: 'chat-resource',
      version: 1,
      modality: 'text',
      ioSchema: { inputs: [], outputs: [] },
      execModes: ['stream'],
      providerType: 'mock-chat',
    },
    pricebookEntry: POST_PRICEBOOK,
    modifiers: [],
    channels: [{ id: 'c1', weight: 1, credentialRef: 'ref-1' }],
    inputs: { __ir: IR },
    execMode: 'stream',
    tenantId: 'tenant-1',
    accountId: 'account-1',
    ...overrides,
  };
  return {
    db: FAKE_DB,
    adapters,
    resolveSecret: () => Promise.resolve('sk-secret'),
    http: FAKE_HTTP,
    jobId: 'job-1',
    inputs: { __ir: IR },
    holdAmount: 1_000n,
    req,
  };
}

describe('createChatSettlingStream', () => {
  it('forwards IR events verbatim and settles once with snake_case usage', async () => {
    const events: ChatStreamEvent[] = [];
    for await (const ev of createChatSettlingStream(deps())) events.push(ev);

    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_delta',
      'usage',
      'stop',
      'done',
    ]);
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]?.usage).toEqual({ input_tokens: 3, output_tokens: 2 });
    // 2 output tokens × 1µ/token = 2µ.
    expect(settleCalls[0]?.finalCost).toBe(2n);
    expect(failCalls).toHaveLength(0);
  });

  it('mirrors usage_log once (snake_case) when usageLogModel is set', async () => {
    const events: ChatStreamEvent[] = [];
    for await (const ev of createChatSettlingStream(deps({ usageLogModel: 'gpt-4o' }))) {
      events.push(ev);
    }

    expect(settleCalls).toHaveLength(1);
    expect(usageLogCalls).toHaveLength(1);
    // The served channel (`c1`, no per-channel providerType → resource's
    // `mock-chat`) is recorded alongside the snake_case token usage.
    expect(usageLogCalls[0]).toEqual({
      model: 'gpt-4o',
      inputTokens: 3,
      outputTokens: 2,
      channelId: 'c1',
      providerType: 'mock-chat',
    });
  });

  it('does NOT mirror usage_log when usageLogModel is unset', async () => {
    const events: ChatStreamEvent[] = [];
    for await (const ev of createChatSettlingStream(deps())) events.push(ev);

    expect(settleCalls).toHaveLength(1);
    expect(usageLogCalls).toHaveLength(0);
  });

  it('settles exactly once on consumer early-return (disconnect), charging 0 pre-output', async () => {
    const stream = createChatSettlingStream(deps());
    const iter = stream[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.value).toMatchObject({ type: 'message_start' });
    await iter.return(undefined);

    expect(settleCalls).toHaveLength(1);
    expect(failCalls).toHaveLength(0);
    // No usage frame and no output streamed yet → charge the MEASURED partial
    // (0), NEVER the 1000µ hold ceiling (the gross over-bill the sweep caught).
    expect(settleCalls[0]?.finalCost).toBe(0n);
  });

  it('charges the measured streamed output on disconnect after content (not the hold)', async () => {
    const stream = createChatSettlingStream(deps());
    const iter = stream[Symbol.asyncIterator]();
    await iter.next(); // message_start
    await iter.next(); // content_delta 'ok' (2 chars → ceil(2/4)=1 output token)
    await iter.return(undefined);

    expect(settleCalls).toHaveLength(1);
    // 1 measured output token × 1µ/token — the partial work, not the 1000µ hold.
    expect(settleCalls[0]?.finalCost).toBe(1n);
  });

  it('settles the measured partial when the stream ends with no usage frame', async () => {
    const events: ChatStreamEvent[] = [];
    for await (const ev of createChatSettlingStream(deps({}, fakeChatAdapterNoUsage()))) {
      events.push(ev);
    }
    expect(events.map((e) => e.type)).toEqual(['message_start', 'content_delta', 'stop', 'done']);
    expect(settleCalls).toHaveLength(1);
    expect(failCalls).toHaveLength(0);
    // 'ok' streamed → ceil(2/4)=1 output token × 1µ, not the 1000µ hold.
    expect(settleCalls[0]?.finalCost).toBe(1n);
  });

  it('forwards a mid-stream IR error in-band and fails (no settle, no throw)', async () => {
    const events: ChatStreamEvent[] = [];
    for await (const ev of createChatSettlingStream(deps({}, fakeChatAdapterError()))) {
      events.push(ev);
    }
    // The error event is DELIVERED to the consumer (so the dialect renderer can
    // frame it), never thrown — and the job fails/releases the hold (no charge).
    expect(events.map((e) => e.type)).toEqual(['message_start', 'content_delta', 'error']);
    expect(failCalls).toHaveLength(1);
    expect(settleCalls).toHaveLength(0);
  });

  it('fails over to a healthy channel BEFORE the first frame (retryable first-event)', async () => {
    const d = deps(
      {
        channels: [
          { id: 'c1', weight: 2, credentialRef: 'r1', model: 'bad' },
          { id: 'c2', weight: 1, credentialRef: 'r2', model: 'good' },
        ],
      },
      fakeFailoverChatAdapter(),
    );
    d.rng = () => 0; // weighted pick lands on c1 ('bad') first → fail over to c2
    const events: ChatStreamEvent[] = [];
    for await (const ev of createChatSettlingStream(d)) events.push(ev);

    // c1's retryable first-frame error is NOT forwarded; c2's full stream is.
    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_delta',
      'usage',
      'stop',
      'done',
    ]);
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]?.usage).toEqual({ input_tokens: 3, output_tokens: 2 });
    expect(failCalls).toHaveLength(0);
  });

  it('every channel errors on the first frame → in-band error, fail, no settle', async () => {
    const d = deps(
      {
        channels: [
          { id: 'c1', weight: 1, credentialRef: 'r1', model: 'bad' },
          { id: 'c2', weight: 1, credentialRef: 'r2', model: 'bad' },
        ],
      },
      fakeFailoverChatAdapter(),
    );
    d.rng = () => 0;
    const events: ChatStreamEvent[] = [];
    for await (const ev of createChatSettlingStream(d)) events.push(ev);

    expect(events.map((e) => e.type)).toEqual(['error']);
    expect(failCalls).toHaveLength(1);
    expect(settleCalls).toHaveLength(0);
  });

  it('selects the adapter PER CHANNEL and fails over cross-provider on the first frame', async () => {
    // Two adapters under one resource: c1 → openai-fail (retryable first-frame
    // error), c2 → mock-chat (normal stream). rng→0 tries c1 first → fail over
    // to c2; the consumer sees c2's full stream and usage_log records c2/mock-chat.
    const adapters = new AdapterRegistry();
    adapters.register(fakeChatAdapter());
    adapters.register(failingChatAdapter());
    const d = depsWith(adapters, {
      channels: [
        { id: 'c1', weight: 2, credentialRef: 'r1', providerType: 'openai-fail' },
        { id: 'c2', weight: 1, credentialRef: 'r2', providerType: 'mock-chat' },
      ],
      usageLogModel: 'gpt-4o',
    });
    d.rng = () => 0;
    const events: ChatStreamEvent[] = [];
    for await (const ev of createChatSettlingStream(d)) events.push(ev);

    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_delta',
      'usage',
      'stop',
      'done',
    ]);
    expect(settleCalls).toHaveLength(1);
    expect(failCalls).toHaveLength(0);
    expect(usageLogCalls[0]).toMatchObject({ channelId: 'c2', providerType: 'mock-chat' });
  });
});

function buildService(rng?: () => number): InstanceType<typeof ExecutionService> {
  const adapters = new AdapterRegistry();
  adapters.register(fakeChatAdapter());
  adapters.register(failingChatAdapter());
  return new ExecutionService({
    db: FAKE_DB,
    adapters,
    resolveSecret: () => Promise.resolve('sk-secret'),
    http: FAKE_HTTP,
    now: () => new Date('2026-06-16T00:00:00.000Z'),
    enqueue: vi.fn<(jobId: string) => Promise<void>>(() => Promise.resolve()),
    ...(rng !== undefined ? { rng } : {}),
  });
}

function chatReq(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    resource: {
      id: 'chat-resource',
      version: 1,
      modality: 'text',
      ioSchema: { inputs: [], outputs: [] },
      execModes: ['stream'],
      providerType: 'mock-chat',
    },
    pricebookEntry: POST_PRICEBOOK,
    modifiers: [],
    channels: [{ id: 'c1', weight: 1, credentialRef: 'ref-1' }],
    inputs: { __ir: IR },
    execMode: 'stream',
    tenantId: 'tenant-1',
    accountId: 'account-1',
    estimatedUsage: { output_tokens: 1000 },
    ...overrides,
  };
}

describe('ExecutionService.runChatStream / runChat', () => {
  it('runChatStream returns a defined jobId and forwards IR events', async () => {
    const svc = buildService();
    const { jobId, events } = await svc.runChatStream(chatReq());
    expect(jobId).toBeDefined();
    expect(typeof jobId).toBe('string');

    const collected: ChatStreamEvent[] = [];
    for await (const ev of events) collected.push(ev);
    expect(collected.map((e) => e.type)).toEqual([
      'message_start',
      'content_delta',
      'usage',
      'stop',
      'done',
    ]);
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]?.usage).toEqual({ input_tokens: 3, output_tokens: 2 });
  });

  it('runChat blocks, maps usage→snake_case, and settles once', async () => {
    const svc = buildService();
    const { jobId, response, cost } = await svc.runChat(chatReq());
    expect(jobId).toBeDefined();
    expect(response.stopReason).toBe('stop');
    expect(cost.credits).toBe(2n);
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]?.usage).toEqual({ input_tokens: 3, output_tokens: 2 });
  });

  it('runChat selects the adapter PER CHANNEL and fails over cross-provider', async () => {
    // rng → 0 picks c1 (openai-fail) first; its chat throws a retryable
    // AdapterError, so routing fails over to c2 (mock-chat) and that serves.
    const svc = buildService(() => 0);
    const { response, servedBy } = await svc.runChat(
      chatReq({
        channels: [
          { id: 'c1', weight: 2, providerType: 'openai-fail', model: 'm' },
          { id: 'c2', weight: 1, providerType: 'mock-chat', model: 'm' },
        ],
        usageLogModel: 'gpt-4o',
      }),
    );
    expect(response.message.content[0]).toMatchObject({ kind: 'text' });
    expect(servedBy).toMatchObject({ channelId: 'c2', providerType: 'mock-chat' });
    expect(usageLogCalls[0]).toMatchObject({ channelId: 'c2', providerType: 'mock-chat' });
  });

  it('buildContext sets ctx.providerType from the channel, not the resource', async () => {
    // A channel with providerType 'capture' under a resource whose providerType
    // is 'mock-chat'. The AdapterContext passed to the adapter must carry the
    // CHANNEL's providerType ('capture'), not the resource's ('mock-chat').
    // Also verifies ctx.config carries the channel's config (chatgptAccountId).
    const adapters = new AdapterRegistry();
    adapters.register(captureAdapter());
    const svc = new ExecutionService({
      db: FAKE_DB,
      adapters,
      resolveSecret: () => Promise.resolve('sk-secret'),
      http: FAKE_HTTP,
      now: () => new Date('2026-06-16T00:00:00.000Z'),
      enqueue: vi.fn<(jobId: string) => Promise<void>>(() => Promise.resolve()),
    });
    await svc.runChat(
      chatReq({
        channels: [
          {
            id: 'c1',
            weight: 1,
            providerType: 'capture',
            config: { chatgptAccountId: 'acct_x' },
          },
        ],
      }),
    );
    expect(capturedCtx).toBeDefined();
    expect(capturedCtx?.providerType).toBe('capture');
    expect(capturedCtx?.config?.chatgptAccountId).toBe('acct_x');
  });
});
