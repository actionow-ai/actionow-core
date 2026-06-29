import type { JobProgressEvent } from '@actionow/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TenantContext } from '../src/auth/auth.service.js';
import { engineNotFound } from '../src/common/errors.js';
import type { JobProgressBus, JobProgressHandler } from '../src/jobs/job-progress.bus.js';
import { JobStreamService } from '../src/jobs/job-stream.service.js';
import type { JobView } from '../src/jobs/jobs.service.js';
import type { JobsService } from '../src/jobs/jobs.service.js';

const CTX: TenantContext = { tenantId: 't1', accountId: 'a1', subjectId: null };

/** A minimal recording express `Response` double. */
function fakeRes(): {
  headers: Record<string, string>;
  status: number;
  flushed: boolean;
  ended: boolean;
  writes: string[];
  writableEnded: boolean;
  closeHandlers: (() => void)[];
  setHeader: (k: string, v: string) => void;
  flushHeaders: () => void;
  write: (s: string) => void;
  end: () => void;
  on: (ev: string, h: () => void) => void;
  triggerClose: () => void;
} {
  const res = {
    headers: {} as Record<string, string>,
    status: 0,
    flushed: false,
    ended: false,
    writes: [] as string[],
    writableEnded: false,
    closeHandlers: [] as (() => void)[],
    setHeader(k: string, v: string): void {
      this.headers[k] = v;
    },
    status_(code: number): void {
      this.status = code;
    },
    flushHeaders(): void {
      this.flushed = true;
    },
    write(s: string): void {
      this.writes.push(s);
    },
    end(): void {
      this.ended = true;
      this.writableEnded = true;
    },
    on(ev: string, h: () => void): void {
      if (ev === 'close') this.closeHandlers.push(h);
    },
    triggerClose(): void {
      for (const h of this.closeHandlers) h();
    },
  };
  // express `res.status()` returns `this`; map our recorder onto it.
  (res as unknown as { status: (c: number) => unknown }).status = (code: number) => {
    res.status = code;
    return res;
  };
  return res;
}

/** A controllable fake progress bus capturing the active handler. */
function fakeBus(): JobProgressBus & {
  emit: (e: JobProgressEvent) => void;
  unsubscribed: boolean;
  subscribedJobId: string | undefined;
} {
  let handler: JobProgressHandler | undefined;
  const bus = {
    subscribedJobId: undefined as string | undefined,
    unsubscribed: false,
    subscribe(jobId: string, onEvent: JobProgressHandler): () => void {
      bus.subscribedJobId = jobId;
      handler = onEvent;
      return () => {
        bus.unsubscribed = true;
        handler = undefined;
      };
    },
    emit(e: JobProgressEvent): void {
      handler?.(e);
    },
  };
  return bus;
}

const ENV = {
  JOB_STREAM_POLL_MS: 2500,
  JOB_STREAM_HEARTBEAT_MS: 15000,
  JOB_STREAM_MAX_MS: 600000,
} as never;

function view(status: string): JobView {
  return {
    job_id: 'j1',
    status,
    resource_id: 'r1',
    exec_mode: 'async-poll',
    inputs: {},
    output: null,
    usage: null,
    cost: null,
    error: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

/** Build a JobsService double with stubbed `get`/`getOrNull`. */
function fakeJobs(over: Partial<Pick<JobsService, 'get' | 'getOrNull'>>): JobsService {
  return over as unknown as JobsService;
}

describe('JobStreamService.streamTo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) throws engineNotFound BEFORE any header flush when the job is unowned', async () => {
    const jobs = fakeJobs({
      get: () => Promise.reject(engineNotFound('job j1 not found')),
    });
    const svc = new JobStreamService(jobs, fakeBus(), ENV);
    const res = fakeRes();

    await expect(svc.streamTo(res as never, 'j1', CTX)).rejects.toThrow(/not found/);
    expect(res.flushed).toBe(false);
    expect(res.writes).toHaveLength(0);
  });

  it('(b) already-terminal on connect → snapshot + done then end, no subscription', async () => {
    const jobs = fakeJobs({ get: () => Promise.resolve(view('succeeded')) });
    const bus = fakeBus();
    const svc = new JobStreamService(jobs, bus, ENV);
    const res = fakeRes();

    await svc.streamTo(res as never, 'j1', CTX);

    expect(res.flushed).toBe(true);
    const joined = res.writes.join('');
    expect(joined).toContain('event: snapshot');
    expect(joined).toContain('event: done');
    expect(res.ended).toBe(true);
    expect(bus.subscribedJobId).toBeUndefined(); // never subscribed
  });

  it('(c) running → snapshot, then a published {succeeded} → done + end', async () => {
    const jobs = fakeJobs({
      get: () => Promise.resolve(view('running')),
      getOrNull: () => Promise.resolve(view('succeeded')),
    });
    const bus = fakeBus();
    const svc = new JobStreamService(jobs, bus, ENV);
    const res = fakeRes();

    await svc.streamTo(res as never, 'j1', CTX);
    expect(res.writes.join('')).toContain('event: snapshot');
    expect(bus.subscribedJobId).toBe('j1');

    // The publish triggers a DB-confirmed reconcile → terminal.
    bus.emit({ status: 'succeeded' });
    await vi.runOnlyPendingTimersAsync();

    expect(res.writes.join('')).toContain('event: done');
    expect(res.ended).toBe(true);
    expect(bus.unsubscribed).toBe(true);
  });

  it('(d) bus silent → DB-poll backstop emits done on status change', async () => {
    let status = 'running';
    const jobs = fakeJobs({
      get: () => Promise.resolve(view('running')),
      getOrNull: () => Promise.resolve(view(status)),
    });
    const bus = fakeBus();
    const svc = new JobStreamService(jobs, bus, ENV);
    const res = fakeRes();

    await svc.streamTo(res as never, 'j1', CTX);

    // First backstop tick: still running, no terminal frame yet.
    await vi.advanceTimersByTimeAsync(2500);
    expect(res.writes.join('')).not.toContain('event: done');

    // Status flips; next backstop tick delivers the terminal frame WITHOUT pub/sub.
    status = 'succeeded';
    await vi.advanceTimersByTimeAsync(2500);
    expect(res.writes.join('')).toContain('event: done');
    expect(res.ended).toBe(true);
  });

  it('(e) res close → unsubscribe + both timers cleared', async () => {
    const jobs = fakeJobs({
      get: () => Promise.resolve(view('running')),
      getOrNull: () => Promise.resolve(view('running')),
    });
    const bus = fakeBus();
    const svc = new JobStreamService(jobs, bus, ENV);
    const res = fakeRes();
    const clearInt = vi.spyOn(globalThis, 'clearInterval');

    await svc.streamTo(res as never, 'j1', CTX);
    expect(bus.subscribedJobId).toBe('j1');

    res.triggerClose();

    expect(bus.unsubscribed).toBe(true);
    // Two intervals (poll backstop + heartbeat) are cleared on close.
    expect(clearInt).toHaveBeenCalledTimes(2);
    clearInt.mockRestore();
  });
});
