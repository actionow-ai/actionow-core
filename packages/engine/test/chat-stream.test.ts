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

import type { BreakerStore, RoutableChannelRef } from '../src/breaker.js';
import { EngineError } from '../src/errors.js';
import { ExecutionService, type RunRequest } from '../src/execution-service.js';
import {
  type CommittedChatStream,
  createChatSettlingStream,
  openChatStreamCommit,
  type SettlingStreamDeps,
} from '../src/stream.js';

/**
 * A recording {@link BreakerStore}: `filterAvailable` drops the configured
 * `excludeIds`, and `onSuccess`/`onFailure` are captured so a test can assert
 * the streaming write path feeds the FSM. Fail-open by construction.
 */
function recordingBreaker(excludeIds: string[] = []): BreakerStore & {
  successes: { channelId: string; model: string }[];
  failures: { channelId: string; model: string }[];
} {
  const successes: { channelId: string; model: string }[] = [];
  const failures: { channelId: string; model: string }[] = [];
  return {
    successes,
    failures,
    filterAvailable: <C extends RoutableChannelRef>(channels: readonly C[]): Promise<C[]> =>
      Promise.resolve(channels.filter((c) => !excludeIds.includes(c.id))),
    onSuccess: (channelId: string, model: string): Promise<void> => {
      successes.push({ channelId, model });
      return Promise.resolve();
    },
    onFailure: (channelId: string, model: string): Promise<void> => {
      failures.push({ channelId, model });
      return Promise.resolve();
    },
    windowStats: (): Promise<null> => Promise.resolve(null),
  };
}

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
  providerCost?: bigint;
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
        providerCost?: bigint;
      },
    ) => {
      const entry: {
        model: string;
        inputTokens?: number;
        outputTokens?: number;
        channelId?: string;
        providerType?: string;
        providerCost?: bigint;
      } = {
        model: p.model,
      };
      if (p.inputTokens !== undefined) entry.inputTokens = p.inputTokens;
      if (p.outputTokens !== undefined) entry.outputTokens = p.outputTokens;
      if (p.channelId !== undefined) entry.channelId = p.channelId;
      if (p.providerType !== undefined) entry.providerType = p.providerType;
      if (p.providerCost !== undefined) entry.providerCost = p.providerCost;
      usageLogCalls.push(entry);
      return Promise.resolve({});
    },
  ),
  // Enough of the hold/create surface for runChatStream's validateAndHold prefix.
  holdCredits: vi.fn(() => Promise.resolve(true)),
  createJob: vi.fn((_db: unknown, p: { id: string }) => Promise.resolve({ id: p.id })),
  claimIdempotency: vi.fn(() => Promise.resolve({ claimed: true })),
  getJob: vi.fn(() => Promise.resolve(undefined)),
  // The binary `channel_health` cooldown repos (`listCooledDownChannelIds` /
  // `recordChannelFailure`) were removed in resilience-v2 Task 2; the router no
  // longer reaches into @actionow/db for routing health (Phase 3 injects a
  // BreakerStore instead), so nothing more is mocked here.
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
): SettlingStreamDeps {
  const adapters = new AdapterRegistry();
  adapters.register(adapter);
  return depsWith(adapters, overrides);
}

/** Same as {@link deps} but with a caller-supplied registry (multi-adapter). */
function depsWith(
  adapters: AdapterRegistry,
  overrides: Partial<RunRequest> = {},
): SettlingStreamDeps {
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

/**
 * Run BOTH phases the way `runChatStream` does: await `openChatStreamCommit`
 * (Phase 1 — channel selection + first event, throws on total pre-commit
 * failure), then drain `createChatSettlingStream(deps, committed)` (Phase 2). A
 * pre-commit throw propagates here (the caller asserts it); a post-commit error
 * is forwarded in-band by the drain generator.
 */
async function commitAndDrain(d: SettlingStreamDeps): Promise<ChatStreamEvent[]> {
  const committed = await openChatStreamCommit(d);
  const events: ChatStreamEvent[] = [];
  for await (const ev of createChatSettlingStream(d, committed)) events.push(ev);
  return events;
}

describe('createChatSettlingStream', () => {
  it('forwards IR events verbatim and settles once with snake_case usage', async () => {
    const events = await commitAndDrain(deps());

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
    await commitAndDrain(deps({ usageLogModel: 'gpt-4o' }));

    expect(settleCalls).toHaveLength(1);
    expect(usageLogCalls).toHaveLength(1);
    // The served channel (`c1`, no per-channel providerType → resource's
    // `mock-chat`) is recorded alongside the snake_case token usage. With no
    // channel cost columns the Track-5 provider_cost is 0 (margin = full charge).
    expect(usageLogCalls[0]).toEqual({
      model: 'gpt-4o',
      inputTokens: 3,
      outputTokens: 2,
      channelId: 'c1',
      providerType: 'mock-chat',
      providerCost: 0n,
    });
  });

  it('mirrors provider_cost from the served channel cost cols on the stream path (Track 5)', async () => {
    await commitAndDrain(
      deps({
        usageLogModel: 'gpt-4o',
        // Served channel carries cost rates: $1/1M in, $2/1M out (µUSD/1M).
        channels: [
          {
            id: 'c1',
            weight: 1,
            credentialRef: 'ref-1',
            inputCostPer1m: 1_000_000n,
            outputCostPer1m: 2_000_000n,
          },
        ],
      }),
    );

    expect(usageLogCalls).toHaveLength(1);
    // usage is in=3 / out=2: provider_cost = roundHalfUp((3*1_000_000 + 2*2_000_000)/1e6)
    //   = roundHalfUp((3e6 + 4e6)/1e6) = roundHalfUp(7) = 7 µUSD.
    expect(usageLogCalls[0]?.providerCost).toBe(7n);
  });

  it('does NOT mirror usage_log when usageLogModel is unset', async () => {
    await commitAndDrain(deps());

    expect(settleCalls).toHaveLength(1);
    expect(usageLogCalls).toHaveLength(0);
  });

  it('settles exactly once on consumer early-return (disconnect), charging 0 pre-output', async () => {
    const d = deps();
    const committed = await openChatStreamCommit(d);
    const stream = createChatSettlingStream(d, committed);
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
    const d = deps();
    const committed = await openChatStreamCommit(d);
    const stream = createChatSettlingStream(d, committed);
    const iter = stream[Symbol.asyncIterator]();
    await iter.next(); // message_start
    await iter.next(); // content_delta 'ok' (2 chars → ceil(2/4)=1 output token)
    await iter.return(undefined);

    expect(settleCalls).toHaveLength(1);
    // 1 measured output token × 1µ/token — the partial work, not the 1000µ hold.
    expect(settleCalls[0]?.finalCost).toBe(1n);
  });

  it('settles the measured partial when the stream ends with no usage frame', async () => {
    const events = await commitAndDrain(deps({}, fakeChatAdapterNoUsage()));
    expect(events.map((e) => e.type)).toEqual(['message_start', 'content_delta', 'stop', 'done']);
    expect(settleCalls).toHaveLength(1);
    expect(failCalls).toHaveLength(0);
    // 'ok' streamed → ceil(2/4)=1 output token × 1µ, not the 1000µ hold.
    expect(settleCalls[0]?.finalCost).toBe(1n);
  });

  it('forwards a post-commit mid-stream IR error in-band and fails (no settle, no throw)', async () => {
    // The channel commits on a good first event (message_start); a LATER error
    // event is forwarded by the drain generator (so the dialect renderer can
    // frame it), never thrown — and the job fails/releases the hold (no charge).
    const events = await commitAndDrain(deps({}, fakeChatAdapterError()));
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
    const events = await commitAndDrain(d);

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

  it('tries the higher-priority tier first, then cascades to the lower one (Track 4)', async () => {
    // The priority-10 channel ('bad', retryable first-frame error) is tried
    // first regardless of weighted rng; its retryable failure cascades to the
    // priority-0 'good' tier, whose full stream reaches the consumer.
    const d = deps(
      {
        channels: [
          { id: 'good', weight: 5, priority: 0, credentialRef: 'r2', model: 'good' },
          { id: 'bad', weight: 1, priority: 10, credentialRef: 'r1', model: 'bad' },
        ],
      },
      fakeFailoverChatAdapter(),
    );
    // rng→0.99 would weight-pick 'good' (weight 5) first if it were a single
    // tier; the priority tier forces 'bad' (priority 10) first → fail over to 'good'.
    d.rng = () => 0.99;
    const events = await commitAndDrain(d);

    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_delta',
      'usage',
      'stop',
      'done',
    ]);
    expect(settleCalls).toHaveLength(1);
    expect(failCalls).toHaveLength(0);
  });

  it('every channel errors on the first frame → openChatStreamCommit THROWS (not in-band)', async () => {
    // All channels fail RETRYABLY on the first event, so the commit is exhausted
    // → it THROWS an EngineError (the relay degrades / the global filter renders a
    // real HTTP error) rather than yielding an in-band error frame. The throw
    // preserves the underlying retryable code so the relay's degrade gate fires.
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

    const err = await openChatStreamCommit(d).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EngineError);
    // The thrown error carries the LAST channel's retryable code, so the relay's
    // shouldDegradeToNextModel sees a DEGRADE_CODE and degrades to the next model.
    expect((err as EngineError).unified).toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });
    // Nothing settled and nothing failed — runChatStream owns the hold release on
    // a commit throw, not openChatStreamCommit (which never created a job here).
    expect(settleCalls).toHaveLength(0);
    expect(failCalls).toHaveLength(0);
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
    const events = await commitAndDrain(d);

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

  it('excludes a breaker-Open channel from the pre-first-event selection', async () => {
    // c1 ('bad', would error retryably) is breaker-excluded, so the stream picks
    // c2 ('good') WITHOUT attempting c1 — no failure recorded for c1, a commit
    // success recorded for c2. Threads the resolved model into the breaker keys.
    const breaker = recordingBreaker(['c1']);
    const d = deps(
      {
        channels: [
          { id: 'c1', weight: 5, credentialRef: 'r1', model: 'bad' },
          { id: 'c2', weight: 1, credentialRef: 'r2', model: 'good' },
        ],
        usageLogModel: 'gpt-4o',
      },
      fakeFailoverChatAdapter(),
    );
    d.breaker = breaker;
    d.rng = () => 0; // would weight-pick c1 first if it were available
    const events = await commitAndDrain(d);

    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_delta',
      'usage',
      'stop',
      'done',
    ]);
    expect(settleCalls).toHaveLength(1);
    // c1 was never attempted (excluded) → no failure; c2 committed → one success.
    expect(breaker.failures).toEqual([]);
    expect(breaker.successes).toEqual([{ channelId: 'c2', model: 'gpt-4o' }]);
  });

  it('feeds onFailure on a retryable pre-first-event failover, onSuccess on commit', async () => {
    // c1 ('bad') errors retryably on its first frame → onFailure(c1); the stream
    // fails over to c2 ('good'), which commits → onSuccess(c2). Both keyed on the
    // resolved model ('*' here, no usageLogModel).
    const breaker = recordingBreaker();
    const d = deps(
      {
        channels: [
          { id: 'c1', weight: 2, credentialRef: 'r1', model: 'bad' },
          { id: 'c2', weight: 1, credentialRef: 'r2', model: 'good' },
        ],
      },
      fakeFailoverChatAdapter(),
    );
    d.breaker = breaker;
    d.rng = () => 0; // pick c1 ('bad') first → fail over to c2
    await commitAndDrain(d);

    expect(settleCalls).toHaveLength(1);
    expect(breaker.failures).toEqual([{ channelId: 'c1', model: '*' }]);
    expect(breaker.successes).toEqual([{ channelId: 'c2', model: '*' }]);
  });
});

/** An adapter whose streamChat yields a NON-retryable error on its first event. */
function fakeChatAdapterNonRetryableFirst(): ProviderAdapter {
  return {
    ...fakeChatAdapter(),
    // eslint-disable-next-line @typescript-eslint/require-await
    async *streamChat(): AsyncIterable<ChatStreamEvent> {
      yield {
        type: 'error',
        error: { code: 'content_filtered', message: 'nope', retryable: false },
      };
    },
  };
}

describe('openChatStreamCommit', () => {
  it('commits to the SECOND channel on a retryable first-event from the first (pre-commit failover)', async () => {
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

    const committed = await openChatStreamCommit(d);
    // The committed stream is served by the SECOND channel, and its first event is
    // the good channel's first frame (not the first channel's retryable error).
    expect(committed.servedChannel.id).toBe('c2');
    expect(committed.first).toMatchObject({ type: 'message_start' });
    // No settle/fail happened in the commit phase — that is the drain's job.
    expect(settleCalls).toHaveLength(0);
    expect(failCalls).toHaveLength(0);
  });

  it('throws the unified error on a NON-retryable first event (no failover, no degrade)', async () => {
    const d = deps(
      {
        channels: [
          { id: 'c1', weight: 2, credentialRef: 'r1', model: 'm1' },
          { id: 'c2', weight: 1, credentialRef: 'r2', model: 'm2' },
        ],
      },
      fakeChatAdapterNonRetryableFirst(),
    );
    d.rng = () => 0;

    // A non-retryable first error throws AND preserves retryable:false so the
    // relay's shouldDegradeToNextModel does NOT degrade to another model.
    await expect(openChatStreamCommit(d)).rejects.toMatchObject({
      unified: { code: 'content_filtered', retryable: false },
    });
    expect(failCalls).toHaveLength(0);
    expect(settleCalls).toHaveLength(0);
  });

  it('throws when the only channel adapter cannot streamChat (no streamable channel)', async () => {
    // The single channel's adapter exposes no streamChat → the commit cannot open
    // any upstream, so it THROWS a non-retryable EngineError (the relay does not
    // degrade on it). Built on a one-channel set so it cannot fail over.
    const adapters = new AdapterRegistry();
    adapters.register({
      providerType: 'no-stream',
      submit: () => Promise.resolve({ kind: 'sync', output: {}, usage: {} }),
      chat: () =>
        Promise.resolve({
          message: { role: 'assistant', content: [{ kind: 'text', text: 'ok' }] },
          stopReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      extractUsage: () => ({}),
      mapError: () => ({ code: 'upstream_error', message: 'mock', retryable: false }),
    });
    const d = depsWith(adapters, {
      channels: [{ id: 'c1', weight: 1, credentialRef: 'r1', providerType: 'no-stream' }],
    });

    await expect(openChatStreamCommit(d)).rejects.toMatchObject({
      unified: { code: 'internal_error', retryable: false },
    });
  });

  it('resolves a committed stream the drain yields first-then-rest over', async () => {
    const d = deps();
    const committed: CommittedChatStream = await openChatStreamCommit(d);
    expect(committed.first).toMatchObject({ type: 'message_start' });

    const events: ChatStreamEvent[] = [];
    for await (const ev of createChatSettlingStream(d, committed)) events.push(ev);
    // first (message_start) then the rest, drained verbatim and settled once.
    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_delta',
      'usage',
      'stop',
      'done',
    ]);
    expect(settleCalls).toHaveLength(1);
    expect(failCalls).toHaveLength(0);
  });
});

function buildService(
  rng?: () => number,
  breaker?: BreakerStore,
): InstanceType<typeof ExecutionService> {
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
    ...(breaker !== undefined ? { breaker } : {}),
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

  it('runChatStream forwards the injected breaker into the settling stream', async () => {
    // The breaker is injected at the service layer; runChatStream must thread it
    // into createChatSettlingStream so the streaming path is breaker-aware. The
    // single served channel commits → one onSuccess keyed on the resolved model.
    const breaker = recordingBreaker();
    const svc = buildService(undefined, breaker);
    const { events } = await svc.runChatStream(chatReq({ usageLogModel: 'gpt-4o' }));
    const collected: ChatStreamEvent[] = [];
    for await (const ev of events) collected.push(ev);

    expect(settleCalls).toHaveLength(1);
    expect(breaker.successes).toEqual([{ channelId: 'c1', model: 'gpt-4o' }]);
    expect(breaker.failures).toEqual([]);
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
