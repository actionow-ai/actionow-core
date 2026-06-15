import { describe, expect, it } from 'vitest';

import { DifyParseError } from '../src/errors.js';
import { dslHash } from '../src/hash.js';
import { buildResourceDraft } from '../src/register.js';

const DSL = `
app: { mode: workflow, name: 小红书文案配图, icon: "🎨" }
kind: app
version: "0.1.5"
workflow:
  graph:
    nodes:
      - { id: start, data: { type: start, variables: [
            { variable: topic, label: 主题, type: text-input, required: true, max_length: 100 },
            { variable: tone,  label: 语气, type: select, options: [活泼,专业,种草], default: 活泼 } ] } }
      - { id: llm1, data: { type: llm, model: { provider: openai, name: gpt-4o-mini } } }
      - { id: img1, data: { type: tool, provider_type: builtin, tool_name: dalle3 } }
      - { id: end, data: { type: end, outputs: [
            { variable: caption,   value_selector: [llm1, text] },
            { variable: image_url, value_selector: [img1, image] } ] } }
`;

const knownModels = new Set(['openai/gpt-4o-mini']);

describe('buildResourceDraft', () => {
  it('throws metered_not_allowed for a BYO + metered workflow', () => {
    try {
      buildResourceDraft(DSL, {
        resourceId: 'res-1',
        provisionMode: 'byo',
        pricingModel: 'metered',
        knownModels,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DifyParseError);
      expect((err as DifyParseError).code).toBe('metered_not_allowed');
    }
  });

  it('assembles a draft for a BYO + fixed workflow', () => {
    const draft = buildResourceDraft(DSL, {
      resourceId: 'res-1',
      provisionMode: 'byo',
      pricingModel: 'fixed',
      knownModels,
    });

    expect(draft.providerType).toBe('dify-workflow');
    expect(draft.modality).toBe('composite');
    expect(draft.mode).toBe('workflow');
    expect(draft.provisionMode).toBe('byo');
    expect(draft.pricingModel).toBe('fixed');
    expect(draft.dslHash).toBe(dslHash(DSL));

    expect(draft.ioSchema.inputs.map((f) => f.key)).toEqual(['topic', 'tone']);
    expect(draft.ioSchema.outputs.map((f) => f.key)).toEqual(['caption', 'image_url']);
    expect(draft.ioSchema.outputs[0]).toMatchObject({ key: 'caption', type: 'string' });

    expect(draft.compatReport.items.length).toBeGreaterThan(0);
    expect(draft.compatReport.hasBlockers).toBe(false);
  });

  it('allows BYO + matrix', () => {
    const draft = buildResourceDraft(DSL, {
      resourceId: 'res-1',
      provisionMode: 'byo',
      pricingModel: 'matrix',
      knownModels,
    });
    expect(draft.pricingModel).toBe('matrix');
  });

  it('lists requiredSecrets from credential-needing tools', () => {
    const draft = buildResourceDraft(DSL, {
      resourceId: 'res-1',
      provisionMode: 'byo',
      pricingModel: 'fixed',
      knownModels,
    });
    expect(draft.requiredSecrets.length).toBe(1);
    expect(draft.requiredSecrets[0]).toContain('dalle3');
  });

  it('propagates parse errors (unsupported mode)', () => {
    expect(() =>
      buildResourceDraft(DSL.replace('mode: workflow', 'mode: advanced-chat'), {
        resourceId: 'res-1',
        provisionMode: 'byo',
        pricingModel: 'fixed',
        knownModels,
      }),
    ).toThrow(/unsupported_mode/);
  });

  it('still assembles a draft when the report has blockers (caller decides)', () => {
    const dsl = `
app: { mode: workflow, name: x }
kind: app
version: "0.1.0"
workflow:
  graph:
    nodes:
      - { id: start, data: { type: start, variables: [] } }
      - { id: kb1, data: { type: knowledge-retrieval } }
      - { id: end, data: { type: end, outputs: [] } }
`;
    const draft = buildResourceDraft(dsl, {
      resourceId: 'res-2',
      provisionMode: 'byo',
      pricingModel: 'fixed',
      knownModels,
    });
    expect(draft.compatReport.hasBlockers).toBe(true);
  });
});
