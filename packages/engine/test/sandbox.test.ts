import { describe, expect, it } from 'vitest';

import { runHandler, SandboxError } from '../src/sandbox.js';

describe('runHandler (QuickJS-WASM sandbox)', () => {
  it('runs a pure mapRequest and marshals JSON in/out', async () => {
    const code = 'function mapRequest(ctx){ return { method: "POST", model: ctx.model }; }';
    const out = await runHandler(code, 'mapRequest', { model: 'gpt' });
    expect(out).toEqual({ method: 'POST', model: 'gpt' });
  });

  it('exposes NO host bindings (fetch/process/setTimeout undefined)', async () => {
    const code =
      'function mapRequest(){ return { fetch: typeof fetch, process: typeof process, timer: typeof setTimeout }; }';
    const out = await runHandler(code, 'mapRequest', {});
    expect(out).toEqual({ fetch: 'undefined', process: 'undefined', timer: 'undefined' });
  });

  it('times out an infinite loop', async () => {
    const code = 'function mapRequest(){ while(true){} }';
    await expect(runHandler(code, 'mapRequest', {}, { timeoutMs: 50 })).rejects.toBeInstanceOf(
      SandboxError,
    );
  });

  it('surfaces a handler throw as a SandboxError', async () => {
    const code = 'function mapRequest(){ throw new Error("boom"); }';
    await expect(runHandler(code, 'mapRequest', {})).rejects.toThrow(/boom/);
  });

  it('is deterministic for a pure mapper', async () => {
    const code = 'function mapResponse(r){ return { n: r.a + r.b }; }';
    const a = await runHandler(code, 'mapResponse', { a: 2, b: 3 });
    const b = await runHandler(code, 'mapResponse', { a: 2, b: 3 });
    expect(a).toEqual(b);
    expect(a).toEqual({ n: 5 });
  });

  it('cannot mutate host state (arg crosses as JSON, not a reference)', async () => {
    const host = { model: 'x' };
    const code = 'function mapRequest(ctx){ ctx.model = "HACKED"; return ctx.model; }';
    const out = await runHandler(code, 'mapRequest', host);
    expect(out).toBe('HACKED'); // inside the sandbox copy
    expect(host.model).toBe('x'); // host object untouched
  });
});
