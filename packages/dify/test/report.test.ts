import { describe, expect, it } from 'vitest';

import { parseDsl } from '../src/parse.js';
import { buildCompatReport } from '../src/report.js';

const SAMPLE = `
app: { mode: workflow, name: 小红书文案配图, icon: "🎨" }
kind: app
version: "0.1.5"
workflow:
  graph:
    nodes:
      - { id: start, data: { type: start, variables: [] } }
      - { id: llm1, data: { type: llm, model: { provider: openai, name: gpt-4o-mini } } }
      - { id: img1, data: { type: tool, provider_type: builtin, tool_name: dalle3 } }
      - { id: end, data: { type: end, outputs: [] } }
`;

describe('dify compat report', () => {
  it('classifies a known model and a credential-needing tool', () => {
    const p = parseDsl(SAMPLE);
    const report = buildCompatReport(p, {
      knownModels: new Set(['openai/gpt-4o-mini']),
    });
    expect(report.hasBlockers).toBe(false);
    const kinds = report.items.map((i) => i.kind);
    expect(kinds).toContain('model_known');
    expect(kinds).toContain('tool_needs_credentials');
    const tool = report.items.find((i) => i.kind === 'tool_needs_credentials');
    expect(tool?.severity).toBe('warn');
    expect(tool?.detail).toContain('dalle3');
  });

  it('flags an unknown model when not in knownModels', () => {
    const p = parseDsl(SAMPLE);
    const report = buildCompatReport(p, { knownModels: new Set() });
    const model = report.items.find((i) => i.kind === 'model_known' || i.kind === 'model_unknown');
    expect(model?.kind).toBe('model_unknown');
    expect(model?.severity).toBe('warn');
    expect(report.hasBlockers).toBe(false);
  });

  it('blocks knowledge-retrieval and sets hasBlockers', () => {
    const dsl = `
app: { mode: workflow, name: x }
kind: app
version: "0.1.0"
workflow:
  graph:
    nodes:
      - { id: start, data: { type: start, variables: [] } }
      - { id: kb1, data: { type: knowledge-retrieval, dataset_ids: [ds-1] } }
      - { id: end, data: { type: end, outputs: [] } }
`;
    const report = buildCompatReport(parseDsl(dsl), { knownModels: new Set() });
    const kb = report.items.find((i) => i.kind === 'knowledge_reference');
    expect(kb?.severity).toBe('block');
    expect(report.hasBlockers).toBe(true);
  });

  it('blocks datasource nodes as knowledge references', () => {
    const dsl = `
app: { mode: workflow, name: x }
kind: app
version: "0.1.0"
workflow:
  graph:
    nodes:
      - { id: ds1, data: { type: datasource } }
`;
    const report = buildCompatReport(parseDsl(dsl), { knownModels: new Set() });
    expect(report.hasBlockers).toBe(true);
    expect(report.items.find((i) => i.kind === 'knowledge_reference')?.severity).toBe('block');
  });

  it('warns on http-request and code nodes without blocking', () => {
    const dsl = `
app: { mode: workflow, name: x }
kind: app
version: "0.1.0"
workflow:
  graph:
    nodes:
      - { id: http1, data: { type: http-request, url: "https://example.com" } }
      - { id: code1, data: { type: code } }
`;
    const report = buildCompatReport(parseDsl(dsl), { knownModels: new Set() });
    const kinds = report.items.map((i) => i.kind);
    expect(kinds).toContain('external_http');
    expect(kinds).toContain('code_node');
    expect(report.items.every((i) => i.severity === 'warn')).toBe(true);
    expect(report.hasBlockers).toBe(false);
  });

  it('reports top-level dependencies as missing_plugin warnings', () => {
    const dsl = `
app: { mode: workflow, name: x }
kind: app
version: "0.1.0"
dependencies:
  - { type: marketplace, value: { plugin_unique_identifier: "langgenius/dalle:0.0.5" } }
workflow:
  graph:
    nodes:
      - { id: start, data: { type: start, variables: [] } }
`;
    const report = buildCompatReport(parseDsl(dsl), { knownModels: new Set() });
    const plugin = report.items.find((i) => i.kind === 'missing_plugin');
    expect(plugin?.severity).toBe('warn');
    expect(plugin?.detail).toContain('langgenius/dalle');
    expect(report.hasBlockers).toBe(false);
  });

  it('classifies agent / parameter-extractor / question-classifier as model nodes', () => {
    const dsl = `
app: { mode: workflow, name: x }
kind: app
version: "0.1.0"
workflow:
  graph:
    nodes:
      - { id: a1, data: { type: agent, model: { provider: anthropic, name: claude-3-5-sonnet } } }
      - { id: pe1, data: { type: parameter-extractor, model: { provider: openai, name: gpt-4o } } }
      - { id: qc1, data: { type: question-classifier, model: { provider: openai, name: gpt-4o } } }
`;
    const report = buildCompatReport(parseDsl(dsl), {
      knownModels: new Set(['anthropic/claude-3-5-sonnet']),
    });
    const modelItems = report.items.filter(
      (i) => i.kind === 'model_known' || i.kind === 'model_unknown',
    );
    expect(modelItems).toHaveLength(3);
    expect(modelItems.filter((i) => i.kind === 'model_known')).toHaveLength(1);
    expect(modelItems.filter((i) => i.kind === 'model_unknown')).toHaveLength(2);
  });
});
