import { randomUUID } from 'node:crypto';

import type { AdapterRegistry } from '@actionow/adapters';
import { isRetryableAdapterError, routeWithFailover } from '@actionow/adapters';
import type {
  AdapterContext,
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
  type Job,
  settleJob,
} from '@actionow/db';
import {
  applyModifiers,
  DomainError,
  type MicroCredits,
  quote,
  settle,
  validateInputs,
} from '@actionow/domain';

import { EngineError, engineError } from './errors.js';
import { computeFinalCost, serializeAppliedModifiers } from './pricing.js';
import { createSettlingStream } from './stream.js';

/** A routed upstream channel: how to reach one provider endpoint/credential. */
export interface RunChannel {
  id: string;
  weight: number;
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
        output: (job.output ?? {}) as Record<string, unknown>,
        usage: (job.usage ?? {}) as UsageVector,
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
    });
    return { jobId, events };
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
    const adapter = this.deps.adapters.get(req.resource.providerType);
    const rng = this.deps.rng ?? Math.random;

    let result: SubmitResult;
    try {
      result = await routeWithFailover(
        req.channels.map((c) => ({ id: c.id, weight: c.weight, value: c })),
        rng,
        async (channel) => {
          const ctx = await this.buildContext(req, channel);
          return adapter.submit({
            resourceId: req.resource.id,
            modality: req.resource.modality,
            inputs,
            execMode: req.execMode,
            ctx,
          });
        },
        isRetryableAdapterError,
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

    return {
      jobId,
      status: 'succeeded',
      output: result.output,
      usage: result.usage,
      cost: { credits: finalCost },
    };
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
  private async buildContext(req: RunRequest, channel: RunChannel): Promise<AdapterContext> {
    const apiKey =
      channel.credentialRef === undefined
        ? undefined
        : await this.deps.resolveSecret(channel.credentialRef);
    const ctx: AdapterContext = {
      providerType: req.resource.providerType,
      http: this.deps.http,
    };
    if (channel.model !== undefined) ctx.model = channel.model;
    if (channel.endpoint !== undefined) ctx.endpoint = channel.endpoint;
    if (apiKey !== undefined) ctx.apiKey = apiKey;
    const proxyUrl = await this.resolveProxy(channel);
    if (proxyUrl !== undefined) ctx.proxyUrl = proxyUrl;
    if (channel.config !== undefined) ctx.config = channel.config;
    return ctx;
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
