import { describe, expect, it } from 'vitest';

import { capabilitiesToFeatures, featuresToCapabilities } from './param-profile.js';

describe('featuresToCapabilities (Option C — the gate projection)', () => {
  it('maps fine features onto the coarse gate booleans', () => {
    expect(featuresToCapabilities(['tool-call', 'vision', 'json-object'])).toEqual({
      tools: true,
      vision: true,
      audio: false,
      json: true,
      file: false,
      reasoning: false,
    });
  });

  it('json-schema and parallel-tool-call fold into json/tools', () => {
    const caps = featuresToCapabilities(['json-schema', 'parallel-tool-call']);
    expect(caps.tools).toBe(true);
    expect(caps.json).toBe(true);
  });

  it('carries `stream` only when the feature is present (display-only, not a gate key)', () => {
    expect(featuresToCapabilities(['stream']).stream).toBe(true);
    expect('stream' in featuresToCapabilities([])).toBe(false);
  });

  it('empty features → every gate flag explicitly false (deterministic)', () => {
    expect(featuresToCapabilities([])).toEqual({
      tools: false,
      vision: false,
      audio: false,
      json: false,
      file: false,
      reasoning: false,
    });
  });

  it('recognises the full modality set', () => {
    expect(featuresToCapabilities(['audio', 'file', 'reasoning'])).toMatchObject({
      audio: true,
      file: true,
      reasoning: true,
      tools: false,
      vision: false,
      json: false,
    });
  });
});

describe('capabilitiesToFeatures (editor prefill inverse)', () => {
  it('recovers a features array from a coarse caps map', () => {
    expect(capabilitiesToFeatures({ tools: true, vision: true, json: true })).toEqual([
      'tool-call',
      'vision',
      'json-object',
    ]);
  });

  it('ignores false / unknown flags', () => {
    expect(capabilitiesToFeatures({ tools: false, multilingual: true, moderation: true })).toEqual(
      [],
    );
  });

  it('round-trips gate-stably through featuresToCapabilities', () => {
    // The invariant Option C relies on: deriving caps from the features recovered
    // from a caps map yields the SAME gate — so an editor prefill + re-save on a
    // legacy capabilities-only model never changes what the gate enforces.
    const caps = {
      tools: true,
      vision: true,
      audio: true,
      json: true,
      file: true,
      reasoning: true,
    };
    const back = featuresToCapabilities(capabilitiesToFeatures(caps));
    expect(back).toEqual(caps);
  });
});
