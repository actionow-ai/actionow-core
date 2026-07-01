import type { ChatRequest } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { applyChannelOverride } from '../src/param/apply-override.js';

/** A minimal well-formed IR request; callers spread `params`/`extra` in. */
function ir(partial: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'm',
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
    ...partial,
  };
}

const CTX = { modelName: 'gpt-4o' };

describe('applyChannelOverride (engine stage ②)', () => {
  it('O-1 regression invariant: empty ops (and undefined) return the SAME ref, no source mutation', () => {
    const source = ir({ params: { temperature: 0.7 }, extra: { foo: 1 } });
    const snapshot = structuredClone(source);

    expect(applyChannelOverride(source, { ops: [] }, CTX)).toBe(source);
    expect(applyChannelOverride(source, undefined, CTX)).toBe(source);

    // source untouched (deep-equal to the pre-call snapshot)
    expect(source).toEqual(snapshot);
  });

  it('O-2 set forces a value (override wins over the request value)', () => {
    const source = ir({ params: { temperature: 0.7 } });
    const out = applyChannelOverride(
      source,
      { ops: [{ op: 'set', name: 'temperature', value: 0 }] },
      CTX,
    );
    expect(out.params?.temperature).toBe(0);
    // source not mutated
    expect(source.params?.temperature).toBe(0.7);
  });

  it('O-3 set on an absent param adds it (wire top_p → camel topP)', () => {
    const out = applyChannelOverride(
      ir({ params: {} }),
      { ops: [{ op: 'set', name: 'top_p', value: 0.5 }] },
      CTX,
    );
    expect(out.params?.topP).toBe(0.5);
  });

  it('O-4 clamp above max', () => {
    const out = applyChannelOverride(
      ir({ params: { temperature: 1.9 } }),
      { ops: [{ op: 'clamp', name: 'temperature', max: 1 }] },
      CTX,
    );
    expect(out.params?.temperature).toBe(1);
  });

  it('O-5 clamp below min', () => {
    const out = applyChannelOverride(
      ir({ params: { temperature: -0.2 } }),
      { ops: [{ op: 'clamp', name: 'temperature', min: 0 }] },
      CTX,
    );
    expect(out.params?.temperature).toBe(0);
  });

  it('O-6 clamp in-range is a no-op', () => {
    const out = applyChannelOverride(
      ir({ params: { temperature: 0.5 } }),
      { ops: [{ op: 'clamp', name: 'temperature', min: 0, max: 1 }] },
      CTX,
    );
    expect(out.params?.temperature).toBe(0.5);
  });

  it('O-7 delete removes the param, keeps siblings', () => {
    const out = applyChannelOverride(
      ir({ params: { temperature: 0.7, topP: 0.9 } }),
      { ops: [{ op: 'delete', name: 'temperature' }] },
      CTX,
    );
    expect(out.params?.temperature).toBeUndefined();
    expect(out.params?.topP).toBe(0.9);
  });

  it('O-8 dotted path hits a nested extra field', () => {
    const out = applyChannelOverride(
      ir({ extra: { thinking: { budget_tokens: 100 } } }),
      { ops: [{ op: 'set', name: 'thinking.budget_tokens', value: 2048 }] },
      CTX,
    );
    expect(out.extra?.thinking).toEqual({ budget_tokens: 2048 });
  });

  it('O-9 delete on an extra dotted path', () => {
    const out = applyChannelOverride(
      ir({ extra: { a: { b: 1, c: 2 } } }),
      { ops: [{ op: 'delete', name: 'a.b' }] },
      CTX,
    );
    expect(out.extra?.a).toEqual({ c: 2 });
  });

  it('O-10 when.modelMatches MATCHES (same channel, two models)', () => {
    const out = applyChannelOverride(
      ir({ params: { temperature: 0.7 } }),
      { ops: [{ op: 'set', name: 'temperature', value: 0, when: { modelMatches: 'gpt-4o' } }] },
      { modelName: 'gpt-4o' },
    );
    expect(out.params?.temperature).toBe(0);
  });

  it('O-11 when.modelMatches MISS leaves the IR unchanged (same ref)', () => {
    // Substring-match miss: the resolved model 'gpt-4o' does NOT contain 'claude',
    // so the guarded op is skipped and the source IR is returned untouched.
    const source = ir({ params: { temperature: 0.7 } });
    const out = applyChannelOverride(
      source,
      { ops: [{ op: 'set', name: 'temperature', value: 0, when: { modelMatches: 'claude' } }] },
      { modelName: 'gpt-4o' },
    );
    expect(out).toBe(source);
    expect(out.params?.temperature).toBe(0.7);
  });

  it('O-12 ordered ops (set then clamp) compose in order', () => {
    const out = applyChannelOverride(
      ir({ params: {} }),
      {
        ops: [
          { op: 'set', name: 'temperature', value: 5 },
          { op: 'clamp', name: 'temperature', max: 2 },
        ],
      },
      CTX,
    );
    expect(out.params?.temperature).toBe(2);
  });

  it('O-13 set on an unknown (non-standard) bare name rides extra, not params', () => {
    const out = applyChannelOverride(
      ir({ extra: {} }),
      { ops: [{ op: 'set', name: 'enable_thinking', value: true }] },
      CTX,
    );
    expect(out.extra?.enable_thinking).toBe(true);
    expect((out.params as Record<string, unknown> | undefined)?.enable_thinking).toBeUndefined();
  });
});
