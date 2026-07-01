import type { ChatRequest, ModelParamProfile, ParamOverride } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { channelSupportsParams, requestParamNames } from '../src/param/require-params.js';

/** A minimal well-formed IR request; callers spread `params`/`extra` in. */
function ir(partial: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'm',
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
    ...partial,
  };
}

describe('requestParamNames', () => {
  it('maps IR params (camelCase) to wire names + collects top-level extra keys', () => {
    const names = requestParamNames(
      ir({
        params: { temperature: 0.7, topP: 0.9, maxOutputTokens: 100 },
        extra: { enable_thinking: true, 'thinking.budget': 2048 },
      }),
    );
    expect(names).toEqual(new Set(['temperature', 'top_p', 'max_tokens', 'enable_thinking']));
    // A DOTTED extra path is a nested field, not a top-level gated param.
    expect(names.has('thinking.budget')).toBe(false);
  });

  it('empty request → empty set', () => {
    expect(requestParamNames(ir())).toEqual(new Set());
  });
});

describe('channelSupportsParams (require_params predicate, D3)', () => {
  const requested = new Set(['temperature', 'top_p']);

  it('supports everything when no override + no profile (regression baseline)', () => {
    expect(channelSupportsParams(requested, undefined, undefined, 'gpt-4o')).toBe(true);
  });

  it('supports when the request carries no params (empty set)', () => {
    expect(channelSupportsParams(new Set(), undefined, undefined, 'gpt-4o')).toBe(true);
  });

  it('does NOT support a param the override deletes', () => {
    const ov: ParamOverride = { ops: [{ op: 'delete', name: 'top_p' }] };
    expect(channelSupportsParams(requested, ov, undefined, 'gpt-4o')).toBe(false);
  });

  it('supports when an override delete targets a DIFFERENT param', () => {
    const ov: ParamOverride = { ops: [{ op: 'delete', name: 'seed' }] };
    expect(channelSupportsParams(requested, ov, undefined, 'gpt-4o')).toBe(true);
  });

  it('a set/clamp op does NOT count as unsupported (only delete strips)', () => {
    const ov: ParamOverride = {
      ops: [
        { op: 'set', name: 'temperature', value: 0 },
        { op: 'clamp', name: 'top_p', max: 0.5 },
      ],
    };
    expect(channelSupportsParams(requested, ov, undefined, 'gpt-4o')).toBe(true);
  });

  it('respects when.modelMatches: a delete gated to a non-matching model does not strip', () => {
    const ov: ParamOverride = {
      ops: [{ op: 'delete', name: 'top_p', when: { modelMatches: 'gpt-5' } }],
    };
    expect(channelSupportsParams(requested, ov, undefined, 'gpt-4o')).toBe(true);
    // Same op on a matching model → unsupported.
    expect(channelSupportsParams(requested, ov, undefined, 'gpt-5-turbo')).toBe(false);
  });

  it('a dotted delete gates on the ROOT extra param', () => {
    const ov: ParamOverride = { ops: [{ op: 'delete', name: 'thinking.budget' }] };
    expect(channelSupportsParams(new Set(['thinking']), ov, undefined, 'gpt-4o')).toBe(false);
  });

  it('profile dropPolicy:drop makes an undeclared known-standard param unsupported', () => {
    const profile: ModelParamProfile = {
      features: [],
      parameterRules: [{ name: 'temperature' }],
      dropPolicy: 'drop',
    };
    // temperature is declared → kept; top_p is NOT declared → dropped → unsupported.
    expect(channelSupportsParams(requested, undefined, profile, 'gpt-4o')).toBe(false);
    expect(channelSupportsParams(new Set(['temperature']), undefined, profile, 'gpt-4o')).toBe(
      true,
    );
  });

  it('profile dropPolicy:passthrough never makes a param unsupported (default)', () => {
    const profile: ModelParamProfile = {
      features: [],
      parameterRules: [],
      dropPolicy: 'passthrough',
    };
    expect(channelSupportsParams(requested, undefined, profile, 'gpt-4o')).toBe(true);
  });
});
