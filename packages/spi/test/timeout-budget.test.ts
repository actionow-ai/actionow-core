// applyTimeoutBudget: the four-timeout → HttpRequest field mapping (§6-④),
// engine-mapping semantics: ttft → firstChunkTimeoutMs, total → timeoutMs,
// connect/idle 1:1; preset request fields always win.
import type { HttpRequest } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { applyTimeoutBudget } from '../src/index.js';

const req: HttpRequest = { method: 'POST', url: 'https://api.test/x' };

describe('applyTimeoutBudget', () => {
  it('maps all four budget fields onto their HttpRequest counterparts', () => {
    const out = applyTimeoutBudget(req, {
      connectTimeoutMs: 1_000,
      ttftTimeoutMs: 2_000,
      totalTimeoutMs: 3_000,
      idleTimeoutMs: 4_000,
    });
    expect(out.connectTimeoutMs).toBe(1_000);
    expect(out.firstChunkTimeoutMs).toBe(2_000); // ttft → firstChunkTimeoutMs
    expect(out.timeoutMs).toBe(3_000); // total → timeoutMs
    expect(out.idleTimeoutMs).toBe(4_000);
  });

  it('never overrides fields the request already set', () => {
    const preset: HttpRequest = {
      ...req,
      timeoutMs: 111,
      connectTimeoutMs: 222,
      firstChunkTimeoutMs: 333,
      idleTimeoutMs: 444,
    };
    const out = applyTimeoutBudget(preset, {
      connectTimeoutMs: 1,
      ttftTimeoutMs: 2,
      totalTimeoutMs: 3,
      idleTimeoutMs: 4,
    });
    expect(out).toMatchObject({
      timeoutMs: 111,
      connectTimeoutMs: 222,
      firstChunkTimeoutMs: 333,
      idleTimeoutMs: 444,
    });
  });

  it('partial budgets fill only their own fields; undefined budget is a no-op copy', () => {
    const partial = applyTimeoutBudget(req, { ttftTimeoutMs: 9_000 });
    expect(partial.firstChunkTimeoutMs).toBe(9_000);
    expect(partial.timeoutMs).toBeUndefined();
    expect(partial.connectTimeoutMs).toBeUndefined();
    expect(partial.idleTimeoutMs).toBeUndefined();

    const untouched = applyTimeoutBudget(req, undefined);
    expect(untouched).toEqual(req);
    expect(untouched).not.toBe(req); // pure: fresh object, input never mutated
  });
});
