import { randomUUID } from 'node:crypto';

import type { AdapterRegistry } from '@actionow/adapters';
import type {
  AdapterContext,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  ExecMode,
  HttpClient,
  IoSchema,
  PricebookEntry,
  StreamEvent,
  SubmitResult,
  SyncResult,
  UnifiedError,
  UsageVector,
} from '@actionow/contracts';
import type { Modifier } from '@actionow/contracts';
import {
  claimIdempotency,
  createJob,
  type DbOrTx,
  failJob,
  getJob,
  holdCredits,
  insertUsageLog,
  type Job,
  settleJob,
} from '@actionow/db';
import { insertRelayTrace } from '@actionow/db';
import {
  applyModifiers,
  DomainError,
  type MicroCredits,
  quote,
  settle,
  validateInputs,
} from '@actionow/domain';

import { routeBlocking } from './channel-routing.js';
import { EngineError, engineError } from './errors.js';
import { computeFinalCost, serializeAppliedModifiers } from './pricing.js';
import { type TraceContext, TracingHttpClient } from './relay-trace.js';
import { createChatSettlingStream, createSettlingStream } from './stream.js';

/** Default per-body byte cap when the engine deps carry no `traceMaxBytes`. */
const DEFAULT_TRACE_MAX_BYTES = 1_000_000;

/** A routed upstream channel: how to reach one provider endpoint/credential. */
export interface RunChannel {
  id: string;
  weight: number;
  /** Per-channel provider/adapter; overrides resource.providerType for routing — cross-provider fallback. */
  providerType?: string | undefined;
  /** Opaque secret locator resolved via `resolveSecret`; never logged. */
  credentialRef?: string | undefined;
  model?: string | undefined;
  endpoint?: string | undefined;
  /** Opaque egress-proxy locator resolved via `resolveSecret`; never logged. */
  proxyRef?: string | undefined;
  /** Per-channel protocol config forwarded verbatim to the adapter; never logged. */
  config?: Record<string, unknown> | undefined;
}

/** The frozen resource snapshot the caller passes for this run. */
export interface RunResource {
  id: string;
  version: number;
  modality: string;
  ioSchema: IoSchema;
  execModes: ExecMode[];
  providerType: string;
}

export interface RunRequest {
  resource: RunResource;
  pricebookEntry: PricebookEntry;
  modifiers: Modifier[];
  channels: RunChannel[];
  inputs: Record<string, unknown>;
  execMode: ExecMode;
  tenantId: string;
  accountId: string;
  callbackUrl?: string | undefined;
  idempotencyKey?: string | undefined;
  endUser?: string | undefined;
  /**
   * When set, a best-effort `usage_log` row is mirrored on settle with this model
   * name and the run's token usage (§C.4), populating the console/admin usage
   * views. Absent for non-relay runs (media/dify) → no log written. A log-insert
   * failure never fails the settle (the ledger settle is the source of truth).
   */
  usageLogModel?: string | undefined;
  /** Attributes the usage_log row to the calling api key (P1c). Absent → null. */
  usageLogApiKeyId?: string | undefined;
  /**
   * Upper-bound usage for a `post`-timed pricebook entry; priced via `settle`
   * to size the hold. When absent, `holdFloor` is used.
   */
  estimatedUsage?: UsageVector | undefined;
  /** Fallback hold for a `post` method when no `estimatedUsage` is supplied. */
  holdFloor?: bigint | undefined;
}

export interface RunCost {
  credits: MicroCredits;
}

export type RunOutcome =
  | {
      jobId: string;
      status: 'succeeded';
      output: Record<string, unknown>;
      usage: UsageVector;
      cost: RunCost;
    }
  | { jobId: string; status: 'queued' };

/**
 * The result of a `stream`-mode run: the persisted job id (the hold is already
 * placed when this resolves) plus the `events` async iterable the caller pipes
 * to the SSE transport. Consuming `events` to completion — OR `return()`-ing it
 * early on a client disconnect — settles the job exactly once.
 */
export interface StreamOutcome {
  jobId: string;
  events: AsyncIterable<StreamEvent>;
}

/**
 * The IR-streaming analogue of {@link StreamOutcome}: the persisted job id (the
 * hold is already placed when this resolves) plus the `events` async iterable of
 * IR {@link ChatStreamEvent}s the caller renders to its dialect's SSE framing.
 * Consuming `events` to completion — OR `return()`-ing it early on disconnect —
 * settles the job exactly once. The API reads the settled job from `jobId`
 * (known here, before the first event), since the IR `done` shape is unchanged.
 */
export interface ChatStreamOutcome {
  jobId: string;
  events: AsyncIterable<ChatStreamEvent>;
}

/** The result of a blocking IR {@link runChat}: the job id, IR response, cost. */
export interface ChatRunOutcome {
  jobId: string;
  response: ChatResponse;
  cost: RunCost;
  /** The channel/provider that ultimately served (after any cross-provider failover). */
  servedBy?: { channelId: string; providerType: string; model?: string };
}

export interface ExecutionServiceDeps {
  db: DbOrTx;
  adapters: AdapterRegistry;
  /** Resolve a credential locator to its secret value. Result is never logged. */
  resolveSecret: (ref: string) => Promise<string | undefined>;
  http: HttpClient;
  now: () => Date;
  /** Hand an `async` job to the queue port (worker drives it later). */
  enqueue: (jobId: string) => Promise<void>;
  /** Source of randomness for weighted channel selection (default Math.random). */
  rng?: () => number;
  /** Default hold lifetime in ms; the reaper cancels holds past this. */
  holdTtlMs?: number;
  /** Global egress proxy fallback (UPSTREAM_PROXY_URL) when a channel has no proxyRef. */
  proxyUrlEnv?: string | undefined;
  /**
   * When true (`RELAY_TRACE=full`), wrap `ctx.http` in a {@link TracingHttpClient}
   * so every upstream call's full request+response (incl. raw SSE) is captured to
   * `relay_trace` (best-effort; secrets redacted; bodies capped). Default off.
   */
  traceUpstream?: boolean | undefined;
  /** Per-body byte cap for the trace (RELAY_TRACE_MAX_BYTES). Default 1MB. */
  traceMaxBytes?: number | undefined;
}

const DEFAULT_HOLD_TTL_MS = 15 * 60_000;

/** Execution modes that run synchronously inline rather than via the queue. */
const BLOCKING_MODES: readonly ExecMode[] = ['blocking'];

/**
 * Orchestrates a single `/v1/run` request (§4.1): idempotency → validate →
 * quote+modifiers → atomic hold → job snapshot → blocking route+settle or async
 * enqueue. Pure domain functions compute money; `@actionow/db` owns the atomic
 * ledger transactions. No NestJS, no BullMQ — both apps wrap this plain service.
 */
export class ExecutionService {
  private readonly deps: ExecutionServiceDeps;

  constructor(deps: ExecutionServiceDeps) {
    this.deps = deps;
  }

  async run(req: RunRequest): Promise<RunOutcome> {
    const { db } = this.deps;

    // 1. Idempotency: if the key was already claimed, replay the original job.
    if (req.idempotencyKey !== undefined) {
      const probeJobId = randomUUID();
      const claim = await claimIdempotency(db, req.tenantId, req.idempotencyKey, probeJobId);
      if (!claim.claimed) {
        const existing =
          claim.existingJobId === undefined ? undefined : await getJob(db, claim.existingJobId);
        if (existing === undefined) {
          throw engineError('internal_error', 'idempotency key claimed but job missing');
        }
        return this.replay(existing);
      }
      // We own the key; createJob below must use `probeJobId` so the claim row
      // points at the job we are about to create.
      return this.execute(req, probeJobId);
    }

    return this.execute(req, randomUUID());
  }

  /** Map an already-terminal/queued job back to a {@link RunOutcome}. */
  private replay(job: Job): RunOutcome {
    if (job.status === 'succeeded') {
      return {
        jobId: job.id,
        status: 'succeeded',
        output: job.output ?? {},
        usage: job.usage ?? {},
        cost: { credits: job.costCredits ?? 0n },
      };
    }
    return { jobId: job.id, status: 'queued' };
  }

  /**
   * Open a `stream`-mode run (§4.1 stream branch). Performs the same synchronous
   * prefix as a blocking run — idempotency replay → validate → quote+modifiers →
   * atomic hold (false → `insufficient_credits`) → job snapshot — **before**
   * returning, so a hold failure throws (→ HTTP 402/400) before any SSE byte is
   * written. The returned `events` is the settling generator: consuming it (or
   * `return()`-ing it on disconnect) settles the job exactly once.
   *
   * Idempotency replay is intentionally narrow here: a replayed stream-mode key
   * cannot re-open a live stream, so a non-claimed key surfaces as an
   * `invalid_input` rather than silently returning an empty stream.
   */
  async runStream(req: RunRequest): Promise<StreamOutcome> {
    const { db } = this.deps;
    const jobId = randomUUID();

    if (req.idempotencyKey !== undefined) {
      // We own the key iff this insert claimed it; the claim row then points at
      // the `jobId` we generated above (and pass to `createJob`).
      const claim = await claimIdempotency(db, req.tenantId, req.idempotencyKey, jobId);
      if (!claim.claimed) {
        throw engineError('invalid_input', 'idempotency key already used for a stream run');
      }
    }

    const { inputs, holdAmount } = await this.validateAndHold(req, jobId);

    const events = createSettlingStream({
      db,
      adapters: this.deps.adapters,
      resolveSecret: this.deps.resolveSecret,
      http: this.deps.http,
      jobId,
      inputs,
      holdAmount,
      req,
      proxyUrlEnv: this.deps.proxyUrlEnv,
      ...this.traceStreamDeps(),
    });
    return { jobId, events };
  }

  /**
   * Open an IR-streaming chat run. Same synchronous prefix as {@link runStream}
   * (validate → quote+modifiers → atomic hold → job snapshot) before returning,
   * so a hold failure (→ 402) surfaces before the first SSE byte. The IR
   * `ChatRequest` is carried in `req.inputs.__ir`; the returned `events` is the
   * IR chat settling generator that settles exactly once (and mirrors usage_log
   * when `req.usageLogModel` is set). Additive: does not touch `runStream`.
   */
  async runChatStream(req: RunRequest): Promise<ChatStreamOutcome> {
    const { db } = this.deps;
    const jobId = randomUUID();
    // Validate the user-facing inputs against the resource io_schema with the
    // out-of-band IR stripped (the strict schema rejects unknown keys); the IR
    // is re-attached to the stream's inputs below.
    const { inputs, holdAmount } = await this.validateAndHold(stripIr(req), jobId);

    const events = createChatSettlingStream({
      db,
      adapters: this.deps.adapters,
      resolveSecret: this.deps.resolveSecret,
      http: this.deps.http,
      jobId,
      inputs: withIr(inputs, req.inputs),
      holdAmount,
      req,
      proxyUrlEnv: this.deps.proxyUrlEnv,
      now: this.deps.now,
      rng: this.deps.rng,
      ...this.traceStreamDeps(),
    });
    return { jobId, events };
  }

  /**
   * The trace knobs the settling streams need to wrap `ctx.http` (the streams
   * own their buildContext; we hand them the flag + cap, not a wrapped client,
   * because the channel/jobId are known only inside the stream). Spread into the
   * stream deps so absence leaves the existing behavior unchanged.
   */
  private traceStreamDeps(): { traceUpstream?: boolean; traceMaxBytes?: number } {
    const out: { traceUpstream?: boolean; traceMaxBytes?: number } = {};
    if (this.deps.traceUpstream !== undefined) out.traceUpstream = this.deps.traceUpstream;
    if (this.deps.traceMaxBytes !== undefined) out.traceMaxBytes = this.deps.traceMaxBytes;
    return out;
  }

  /**
   * Blocking IR chat run: same hold prefix, then resolve the adapter, call
   * `adapter.chat(ir, ctx)`, map the IR camelCase `usage` → the snake_case
   * engine {@link UsageVector}, and settle via the existing `settleSync` path
   * (which also fires the `usage_log` mirror when `req.usageLogModel` is set).
   * Additive: does not touch `run`/`runBlocking`.
   */
  async runChat(req: RunRequest): Promise<ChatRunOutcome> {
    const jobId = randomUUID();
    const { inputs, holdAmount } = await this.validateAndHold(stripIr(req), jobId);
    const ir = readIr(inputs, req.inputs);

    // Select the adapter PER CHANNEL inside the routing attempt so an openai
    // channel and an anthropic channel under one resource each render the
    // dialect-neutral IR to their own wire (cross-provider failover). `served`
    // captures the channel that ultimately returned, for the usage_log mirror.
    let served: RunChannel | undefined;
    let response: ChatResponse;
    try {
      response = await routeBlocking(
        { db: this.deps.db, now: this.deps.now, rng: this.deps.rng ?? Math.random },
        req.channels,
        async (channel) => {
          const adapter = this.deps.adapters.get(channel.providerType ?? req.resource.providerType);
          if (adapter.chat === undefined) {
            throw engineError(
              'internal_error',
              `channel adapter ${adapter.providerType} cannot chat`,
            );
          }
          const r = await adapter.chat.bind(adapter)(
            ir,
            await this.buildContext(req, channel, jobId),
          );
          served = channel;
          return r;
        },
      );
    } catch (err) {
      await this.failBlocking(req, jobId, holdAmount, err);
      throw toEngineError(err);
    }

    // camelCase IR usage → snake_case engine UsageVector at the boundary.
    const usage: UsageVector = {
      input_tokens: response.usage.inputTokens,
      output_tokens: response.usage.outputTokens,
    };
    const outcome = await this.settleSync(
      req,
      jobId,
      holdAmount,
      { kind: 'sync', output: { __ir: response }, usage },
      served && {
        channelId: served.id,
        providerType: served.providerType ?? req.resource.providerType,
      },
    );
    const cost = outcome.status === 'succeeded' ? outcome.cost : { credits: 0n };
    const result: ChatRunOutcome = { jobId, response, cost };
    if (served !== undefined) {
      const servedBy: ChatRunOutcome['servedBy'] = {
        channelId: served.id,
        providerType: served.providerType ?? req.resource.providerType,
      };
      if (served.model !== undefined) servedBy.model = served.model;
      result.servedBy = servedBy;
    }
    return result;
  }

  private async execute(req: RunRequest, jobId: string): Promise<RunOutcome> {
    const { inputs, holdAmount, job } = await this.validateAndHold(req, jobId);

    // 6/7. Branch on exec mode.
    if (BLOCKING_MODES.includes(req.execMode)) {
      return this.runBlocking(req, inputs, job.id, holdAmount);
    }
    if (req.execMode === 'stream') {
      // `stream` is opened via `runStream`, which owns the SSE generator. A
      // plain `run()` of a stream resource is a caller error.
      await failJob(this.deps.db, {
        jobId: job.id,
        accountId: req.accountId,
        holdAmount,
        to: 'failed',
        error: {
          code: 'invalid_input',
          message: 'stream mode requires runStream',
          retryable: false,
        },
      });
      throw engineError('invalid_input', 'stream exec mode must be opened via runStream');
    }

    // async → enqueue and return immediately; the worker JobRunner drives it.
    await this.deps.enqueue(job.id);
    return { jobId: job.id, status: 'queued' };
  }

  /**
   * The shared synchronous prefix for blocking/stream/async runs: validate the
   * inputs, compute the modifier-adjusted hold, place the atomic hold (false →
   * `insufficient_credits`, no job), and persist the queued job snapshot.
   */
  private async validateAndHold(
    req: RunRequest,
    jobId: string,
  ): Promise<{ inputs: Record<string, unknown>; holdAmount: MicroCredits; job: Job }> {
    const { db } = this.deps;

    // 2. Validate inputs against the frozen io_schema.
    const validation = validateInputs(req.resource.ioSchema, req.inputs);
    if (!validation.ok) {
      throw new EngineError({
        code: 'invalid_input',
        message: validation.error.message,
        retryable: false,
      });
    }
    const inputs = validation.value;

    // 3. Quote → modifiers → hold amount (an upper bound for post methods).
    const holdAmount = this.computeHold(req, inputs);

    // 4. Atomic hold. False → insufficient_credits, NO job created.
    const held = await holdCredits(db, req.accountId, holdAmount);
    if (!held) {
      throw engineError('insufficient_credits', 'insufficient credits for hold');
    }

    // 5. Create the job (status queued) with the frozen version/hold snapshot.
    const holdExpiresAt = new Date(
      this.deps.now().getTime() + (this.deps.holdTtlMs ?? DEFAULT_HOLD_TTL_MS),
    );
    const job = await this.createSnapshotJob(req, inputs, jobId, holdAmount, holdExpiresAt);
    return { inputs, holdAmount, job };
  }

  /** Compute the modifier-adjusted hold (`pre` quote or `post` upper bound). */
  private computeHold(req: RunRequest, inputs: Record<string, unknown>): MicroCredits {
    const entry = req.pricebookEntry;
    let base: MicroCredits;
    if (entry.timing === 'pre') {
      base = quote(entry, inputs);
    } else if (req.estimatedUsage !== undefined) {
      base = settle(entry, req.estimatedUsage);
    } else if (req.holdFloor !== undefined) {
      base = req.holdFloor;
    } else {
      throw engineError(
        'invalid_input',
        'post-timed pricing requires estimatedUsage or holdFloor for the hold',
      );
    }
    return applyModifiers(base, req.modifiers).final;
  }

  private async createSnapshotJob(
    req: RunRequest,
    inputs: Record<string, unknown>,
    jobId: string,
    holdAmount: MicroCredits,
    holdExpiresAt: Date,
  ): Promise<Job> {
    return createJob(this.deps.db, {
      id: jobId,
      tenantId: req.tenantId,
      resourceId: req.resource.id,
      resourceVersion: req.resource.version,
      execMode: req.execMode,
      inputs,
      pricebookVersion: req.pricebookEntry.version,
      modifiersSnapshot: req.modifiers,
      quotedCredits: holdAmount,
      holdExpiresAt,
      callbackUrl: req.callbackUrl ?? null,
      idempotencyKey: req.idempotencyKey ?? null,
      endUser: req.endUser ?? null,
    });
  }

  /**
   * Blocking path: route to a channel (weighted pick + failover), get a
   * `SyncResult`, price the final cost, and atomically settle. On a hard
   * failure across every channel, fail the job (release hold) and raise the
   * unified error.
   */
  private async runBlocking(
    req: RunRequest,
    inputs: Record<string, unknown>,
    jobId: string,
    holdAmount: MicroCredits,
  ): Promise<RunOutcome> {
    const rng = this.deps.rng ?? Math.random;

    let result: SubmitResult;
    try {
      result = await routeBlocking(
        { db: this.deps.db, now: this.deps.now, rng },
        req.channels,
        async (channel) => {
          // Select the adapter per channel so channels under one resource can
          // target different providers (cross-provider failover).
          const adapter = this.deps.adapters.get(channel.providerType ?? req.resource.providerType);
          return adapter.submit({
            resourceId: req.resource.id,
            modality: req.resource.modality,
            inputs,
            execMode: req.execMode,
            ctx: await this.buildContext(req, channel, jobId),
          });
        },
      );
    } catch (err) {
      await this.failBlocking(req, jobId, holdAmount, err);
      throw toEngineError(err);
    }

    if (result.kind !== 'sync') {
      // A blocking resource must yield a synchronous result; an async handle is
      // a misconfiguration. Release the hold and surface it.
      await failJob(this.deps.db, {
        jobId,
        accountId: req.accountId,
        holdAmount,
        to: 'failed',
        error: { code: 'internal_error', message: 'blocking adapter returned async handle' },
      });
      throw engineError('internal_error', 'blocking adapter returned an async handle');
    }

    return this.settleSync(req, jobId, holdAmount, result);
  }

  /** Price the final cost from a sync result and settle atomically. */
  private async settleSync(
    req: RunRequest,
    jobId: string,
    holdAmount: MicroCredits,
    result: SyncResult,
    served?: { channelId: string; providerType: string },
  ): Promise<RunOutcome> {
    const entry = req.pricebookEntry;
    const { credits: finalCost, applied } = computeFinalCost(
      entry,
      result.usage,
      req.inputs,
      req.modifiers,
    );

    await settleJob(this.deps.db, {
      jobId,
      accountId: req.accountId,
      tenantId: req.tenantId,
      holdAmount,
      finalCost,
      usage: result.usage,
      output: result.output,
      pricebookVersion: entry.version,
      modifiersApplied: serializeAppliedModifiers(applied),
      resourceId: req.resource.id,
      ...(req.callbackUrl !== undefined
        ? { outbox: { url: req.callbackUrl, payload: { job_id: jobId } } }
        : {}),
    });

    // Relay-only, best-effort usage mirror (§C.4). Gated on `usageLogModel`, so
    // non-relay runs (media/dify) write no row. The settle already committed in
    // its own transaction above; a log-insert failure is swallowed so a usage
    // observability hiccup never fails (or rolls back) a settled run.
    await this.mirrorUsageLog(req, finalCost, result.usage, served);

    return {
      jobId,
      status: 'succeeded',
      output: result.output,
      usage: result.usage,
      cost: { credits: finalCost },
    };
  }

  /**
   * Mirror a settled relay run into `usage_log` (best-effort). No-op unless
   * `req.usageLogModel` is set (relay calls). Token counts come from the run's
   * snake_case `UsageVector` (`input_tokens`/`output_tokens`, missing → 0) —
   * the shape every adapter emits and `priceModelToken` prices off. Any error
   * is logged-and-swallowed: the ledger settle is the source of truth.
   */
  private async mirrorUsageLog(
    req: RunRequest,
    finalCost: MicroCredits,
    usage: UsageVector,
    served?: { channelId: string; providerType: string },
  ): Promise<void> {
    if (req.usageLogModel === undefined) return;
    try {
      await insertUsageLog(this.deps.db, {
        tenantId: req.tenantId,
        model: req.usageLogModel,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cost: finalCost,
        status: 'succeeded',
        ...(served !== undefined
          ? { channelId: served.channelId, providerType: served.providerType }
          : {}),
        ...(req.usageLogApiKeyId !== undefined ? { apiKeyId: req.usageLogApiKeyId } : {}),
      });
    } catch {
      // Best-effort observability: never fail a settled run on a usage-log error.
    }
  }

  private async failBlocking(
    req: RunRequest,
    jobId: string,
    holdAmount: MicroCredits,
    err: unknown,
  ): Promise<void> {
    const unified = toUnified(err);
    await failJob(this.deps.db, {
      jobId,
      accountId: req.accountId,
      holdAmount,
      to: 'failed',
      error: unified,
      ...(req.callbackUrl !== undefined
        ? { outbox: { url: req.callbackUrl, payload: { job_id: jobId, error: unified } } }
        : {}),
    });
  }

  /** Build the per-attempt adapter context, resolving the channel secret. */
  private async buildContext(
    req: RunRequest,
    channel: RunChannel,
    jobId: string,
  ): Promise<AdapterContext> {
    const apiKey =
      channel.credentialRef === undefined
        ? undefined
        : await this.deps.resolveSecret(channel.credentialRef);
    const providerType = channel.providerType ?? req.resource.providerType;
    const ctx: AdapterContext = {
      providerType,
      http: this.maybeTrace({
        tenantId: req.tenantId,
        jobId,
        channelId: channel.id,
        providerType,
      }),
    };
    if (channel.model !== undefined) ctx.model = channel.model;
    if (channel.endpoint !== undefined) ctx.endpoint = channel.endpoint;
    if (apiKey !== undefined) ctx.apiKey = apiKey;
    const proxyUrl = await this.resolveProxy(channel);
    if (proxyUrl !== undefined) ctx.proxyUrl = proxyUrl;
    if (channel.config !== undefined) ctx.config = channel.config;
    return ctx;
  }

  /**
   * Wrap the shared `http` in a {@link TracingHttpClient} when tracing is on,
   * else return it unwrapped. The sink is a best-effort `insertRelayTrace`.
   */
  private maybeTrace(trace: TraceContext): HttpClient {
    if (this.deps.traceUpstream !== true) return this.deps.http;
    const db = this.deps.db;
    return new TracingHttpClient(
      this.deps.http,
      async (row) => {
        await insertRelayTrace(db, row);
      },
      trace,
      this.deps.traceMaxBytes ?? DEFAULT_TRACE_MAX_BYTES,
    );
  }

  /** Resolve a channel's egress proxy URL: its proxyRef (via resolveSecret), else the global env fallback. */
  private async resolveProxy(channel: RunChannel): Promise<string | undefined> {
    if (channel.proxyRef !== undefined) {
      const url = await this.deps.resolveSecret(channel.proxyRef);
      if (url !== undefined) return url;
    }
    return this.deps.proxyUrlEnv;
  }
}

/**
 * The opaque key under which a chat run carries its IR `ChatRequest` through
 * `RunRequest.inputs` — out-of-band from the resource's user-facing io_schema,
 * which validates the rest of `inputs`.
 */
const IR_KEY = '__ir';

/**
 * Re-attach the IR (carried on the original `req.inputs.__ir`) to the validated
 * inputs the resource io_schema produced, so the chat settling stream can read
 * it from `inputs.__ir`. The io_schema strips unknown keys, so `__ir` is added
 * back here rather than relying on it surviving validation.
 */
function withIr(
  validated: Record<string, unknown>,
  original: Record<string, unknown>,
): Record<string, unknown> {
  const ir = original[IR_KEY];
  return ir === undefined ? validated : { ...validated, [IR_KEY]: ir };
}

/**
 * A shallow copy of a chat `RunRequest` with the out-of-band `__ir` key removed
 * from `inputs`, so the strict resource io_schema validation (which rejects
 * unknown keys) passes on the user-facing inputs only.
 */
function stripIr(req: RunRequest): RunRequest {
  if (!(IR_KEY in req.inputs)) return req;
  const inputs = Object.fromEntries(Object.entries(req.inputs).filter(([k]) => k !== IR_KEY));
  return { ...req, inputs };
}

/** Read + assert the IR `ChatRequest` carried at `__ir`. */
function readIr(
  validated: Record<string, unknown>,
  original: Record<string, unknown>,
): ChatRequest {
  const ir = (original[IR_KEY] ?? validated[IR_KEY]) as ChatRequest | undefined;
  if (ir === undefined) {
    throw engineError('internal_error', 'chat run requires inputs.__ir');
  }
  return ir;
}

/** Coerce any thrown value into a unified error payload (sanitized). */
function toUnified(err: unknown): UnifiedError {
  if (err instanceof EngineError) return err.unified;
  if (isUnifiedCarrier(err)) return err.unified;
  if (err instanceof DomainError) {
    return { code: 'invalid_input', message: err.message, retryable: false };
  }
  return { code: 'upstream_error', message: 'upstream error', retryable: false };
}

function toEngineError(err: unknown): EngineError {
  if (err instanceof EngineError) return err;
  return new EngineError(toUnified(err));
}

interface UnifiedCarrier {
  unified: UnifiedError;
}
function isUnifiedCarrier(err: unknown): err is UnifiedCarrier {
  return (
    typeof err === 'object' && err !== null && 'unified' in err && typeof err.unified === 'object'
  );
}
