import type { ChatRequest, ModelParamProfile } from '@actionow/contracts';
import type { ModelCapabilities } from '@actionow/llm-protocol';
import { describe, expect, it } from 'vitest';

import { EngineError } from '../src/errors.js';
import {
  applyProfileDefaults,
  clampToRules,
  dropUnsupported,
  gate,
  isEmptyProfile,
} from '../src/param/apply-profile.js';

/** A minimal well-formed IR request; callers spread `params`/`extra` in. */
function ir(partial: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'm',
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
    ...partial,
  };
}

/** Build a profile with defaults filled in (mirrors modelParamProfileSchema). */
function profile(p: Partial<ModelParamProfile> = {}): ModelParamProfile {
  return { features: [], parameterRules: [], dropPolicy: 'passthrough', ...p };
}

const EMPTY = profile();
const NO_CAPS: ModelCapabilities = { tools: false, vision: false, audio: false, json: false };

describe('isEmptyProfile', () => {
  it('true for undefined and for the empty profile', () => {
    expect(isEmptyProfile(undefined)).toBe(true);
    expect(isEmptyProfile(EMPTY)).toBe(true);
    // dropPolicy alone does not make it non-empty (no rules → nothing to prune).
    expect(isEmptyProfile(profile({ dropPolicy: 'drop' }))).toBe(true);
  });
  it('false when features or rules are present', () => {
    expect(isEmptyProfile(profile({ features: ['reasoning'] }))).toBe(false);
    expect(isEmptyProfile(profile({ parameterRules: [{ name: 'temperature' }] }))).toBe(false);
  });
});

describe('applyProfileDefaults (stage ①)', () => {
  it('P-1 regression invariant: empty profile returns the SAME ref (deep-equal, no mutation)', () => {
    const src = ir({ params: { temperature: 0.7 }, extra: { foo: 1 } });
    const snap = structuredClone(src);
    expect(applyProfileDefaults(src, EMPTY)).toBe(src);
    expect(src).toEqual(snap);
  });

  it('P-2 fills a declared default when the request omits the param', () => {
    const p = profile({ parameterRules: [{ name: 'temperature', default: 0.8 }] });
    const out = applyProfileDefaults(ir(), p);
    expect(out.params?.temperature).toBe(0.8);
  });

  it('P-3 the request value wins (default does NOT overwrite)', () => {
    const p = profile({ parameterRules: [{ name: 'temperature', default: 0.8 }] });
    const out = applyProfileDefaults(ir({ params: { temperature: 0.2 } }), p);
    expect(out.params?.temperature).toBe(0.2);
  });

  it('fills a model-specific declared param via extra (D2 passthrough)', () => {
    const p = profile({ parameterRules: [{ name: 'enable_thinking', default: true }] });
    const out = applyProfileDefaults(ir(), p);
    expect(out.extra?.enable_thinking).toBe(true);
  });

  it('resolves a template default (useTemplate → template.default)', () => {
    const p = profile({ parameterRules: [{ name: 'max_tokens', useTemplate: 'max_tokens' }] });
    const out = applyProfileDefaults(ir(), p);
    expect(out.params?.maxOutputTokens).toBe(1024);
  });
});

describe('clampToRules (stage ①)', () => {
  it('regression invariant: empty profile returns the SAME ref', () => {
    const src = ir({ params: { temperature: 1.9 } });
    expect(clampToRules(src, EMPTY)).toBe(src);
  });

  it('P-4 clamps above max', () => {
    const p = profile({ parameterRules: [{ name: 'temperature', max: 1 }] });
    const out = clampToRules(ir({ params: { temperature: 1.9 } }), p);
    expect(out.params?.temperature).toBe(1);
  });

  it('clamps below min', () => {
    const p = profile({ parameterRules: [{ name: 'temperature', min: 0 }] });
    const out = clampToRules(ir({ params: { temperature: -0.2 } }), p);
    expect(out.params?.temperature).toBe(0);
  });

  it('in-range is a no-op (same ref)', () => {
    const p = profile({ parameterRules: [{ name: 'temperature', min: 0, max: 1 }] });
    const src = ir({ params: { temperature: 0.5 } });
    expect(clampToRules(src, p)).toBe(src);
  });

  it('P-5 dropPolicy:error throws EngineError(invalid_input) out of range', () => {
    const p = profile({ dropPolicy: 'error', parameterRules: [{ name: 'temperature', max: 1 }] });
    let err: unknown;
    try {
      clampToRules(ir({ params: { temperature: 1.9 } }), p);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).unified.code).toBe('invalid_input');
  });
});

describe('gate (stage ③) — capability + reasoning, profile-driven with fallback', () => {
  it('P-6 gate lacking tool-call throws when request has tools (parity with normalize tools-400)', () => {
    const withTools: ChatRequest = ir({ tools: [{ name: 'f', parameters: { type: 'object' } }] });
    expect(() => gate(withTools, NO_CAPS, EMPTY)).toThrow();
  });

  it('P-7 reasoning downgrade via profile drops temperature/topP/stop + penalties, keeps allowed', () => {
    // A reasoning profile whose rules ALLOW only maxOutputTokens → the sampling
    // knobs + penalties are dropped (exact parity with normalize.test.ts DOWNGRADE).
    const p = profile({
      features: ['reasoning'],
      parameterRules: [{ name: 'max_tokens', useTemplate: 'max_tokens' }],
    });
    const req: ChatRequest = ir({
      params: { temperature: 0.7, topP: 0.9, stop: ['END'], maxOutputTokens: 256 },
      extra: {
        presence_penalty: 0.5,
        frequency_penalty: 0.2,
        logprobs: true,
        prompt_cache_key: 'keep',
      },
    });
    const out = gate(req, { ...NO_CAPS, reasoning: true }, p);
    expect(out.params?.temperature).toBeUndefined();
    expect(out.params?.topP).toBeUndefined();
    expect(out.params?.stop).toBeUndefined();
    expect(out.params?.maxOutputTokens).toBe(256);
    expect(out.extra).toEqual({ prompt_cache_key: 'keep' });
  });

  it('gate with an empty profile falls back to hardcoded reasoning downgrade (caps.reasoning)', () => {
    const req: ChatRequest = ir({
      params: { temperature: 0.7, topP: 0.9, stop: ['END'], maxOutputTokens: 256 },
      extra: { presence_penalty: 0.5, prompt_cache_key: 'keep' },
    });
    const out = gate(req, { ...NO_CAPS, reasoning: true }, EMPTY);
    expect(out.params?.temperature).toBeUndefined();
    expect(out.params?.maxOutputTokens).toBe(256);
    expect(out.extra).toEqual({ prompt_cache_key: 'keep' });
  });

  it('gate is a no-op for a plain non-reasoning model with an empty profile', () => {
    const src = ir({ params: { temperature: 0.7 }, extra: { presence_penalty: 0.5 } });
    expect(gate(src, NO_CAPS, EMPTY)).toBe(src);
  });
});

describe('dropUnsupported (stage ④)', () => {
  it('P-8 passthrough (default) keeps an unknown non-standard extra key AND is same-ref', () => {
    const body = { model: 'm', top_k: 40, prompt_cache_key: 'x' };
    expect(dropUnsupported(body, profile({ dropPolicy: 'passthrough' }))).toBe(body);
    // undefined profile is also same-ref (regression invariant)
    expect(dropUnsupported(body, undefined)).toBe(body);
  });

  it('P-8b passthrough never drops a known-standard undeclared param either', () => {
    const body = { model: 'm', top_p: 0.9 };
    expect(dropUnsupported(body, profile({ dropPolicy: 'passthrough' }))).toBe(body);
  });

  it('P-9 drop removes a known-standard param NOT in parameterRules', () => {
    const p = profile({ dropPolicy: 'drop', parameterRules: [{ name: 'temperature' }] });
    const out = dropUnsupported({ model: 'm', temperature: 0.5, top_p: 0.9, top_k: 40 }, p);
    expect(out).toEqual({ model: 'm', temperature: 0.5, top_k: 40 }); // top_p dropped, top_k (non-standard) kept
  });

  it('drop keeps a declared param (allow-list, incl. template alias)', () => {
    const p = profile({
      dropPolicy: 'drop',
      parameterRules: [{ name: 'top_p', useTemplate: 'top_p' }],
    });
    const out = dropUnsupported({ model: 'm', top_p: 0.9 }, p);
    expect(out.top_p).toBe(0.9);
  });

  it('P-10 error throws when a known-standard undeclared param is present', () => {
    const p = profile({ dropPolicy: 'error', parameterRules: [{ name: 'temperature' }] });
    let err: unknown;
    try {
      dropUnsupported({ model: 'm', top_p: 0.9 }, p);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).unified.code).toBe('invalid_input');
  });
});

describe('P-11 full pipeline order (defaults→clamp→gate→drop)', () => {
  it('clamps temp to 1, gate allows tools, keeps tools', () => {
    const p = profile({
      features: ['tool-call'],
      parameterRules: [{ name: 'temperature', min: 0, max: 1 }],
    });
    let req: ChatRequest = ir({
      params: { temperature: 1.9 },
      tools: [{ name: 'f', parameters: { type: 'object' } }],
    });
    req = applyProfileDefaults(req, p);
    req = clampToRules(req, p);
    req = gate(req, { ...NO_CAPS, tools: true }, p);
    expect(req.params?.temperature).toBe(1);
    expect(req.tools).toHaveLength(1);
  });
});

// --- normalize.test.ts PARITY PORT (E1-1): the profile-backed gate reproduces
// the hardcoded capability-gate behavior when the profile is empty. -----------
describe('gate parity with normalizeRequest (E1-1, empty profile == today)', () => {
  const base = ir();
  it('passes a text request through when the model supports text', () => {
    expect(gate(base, NO_CAPS, EMPTY).messages).toHaveLength(1);
  });
  it('400s when tools are sent to a model without tool capability', () => {
    const t = ir({ tools: [{ name: 'f', parameters: { type: 'object' } }] });
    expect(() => gate(t, NO_CAPS, EMPTY)).toThrow();
  });
  it('400s when an image part is sent to a non-vision model', () => {
    const img = ir({
      messages: [
        { role: 'user', content: [{ kind: 'image', source: 'url', data: 'http://x/y.png' }] },
      ],
    });
    expect(() => gate(img, NO_CAPS, EMPTY)).toThrow();
  });
  it('400s on json_object responseFormat for a non-json model', () => {
    const j = ir({ params: { responseFormat: 'json_object' } });
    expect(() => gate(j, NO_CAPS, EMPTY)).toThrow();
  });
  it('400s when a file part is sent to a model without file capability', () => {
    const f = ir({
      messages: [
        { role: 'user', content: [{ kind: 'file', source: 'url', data: 'http://x/d.pdf' }] },
      ],
    });
    expect(() => gate(f, NO_CAPS, EMPTY)).toThrow();
  });
  it('allows a file part when the model declares file capability', () => {
    const f = ir({
      messages: [
        { role: 'user', content: [{ kind: 'file', source: 'url', data: 'http://x/d.pdf' }] },
      ],
    });
    expect(gate(f, { ...NO_CAPS, file: true }, EMPTY).messages).toHaveLength(1);
  });
  it('does NOT downgrade params for a non-reasoning model', () => {
    const req = ir({
      params: { temperature: 0.7, topP: 0.9, stop: ['END'] },
      extra: { presence_penalty: 0.5 },
    });
    const out = gate(req, { ...NO_CAPS, reasoning: false }, EMPTY);
    expect(out.params).toEqual({ temperature: 0.7, topP: 0.9, stop: ['END'] });
    expect(out.extra).toEqual({ presence_penalty: 0.5 });
  });
  it('still 400s a reasoning model on genuine capability misuse (tools)', () => {
    const t = ir({
      tools: [{ name: 'f', parameters: { type: 'object' } }],
      params: { temperature: 0.7 },
    });
    expect(() => gate(t, { ...NO_CAPS, reasoning: true }, EMPTY)).toThrow();
  });
});
