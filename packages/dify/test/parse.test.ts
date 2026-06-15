import { describe, expect, it } from 'vitest';

import { DifyParseError } from '../src/errors.js';
import { extractInputs, extractOutputs } from '../src/io-schema.js';
import { parseDsl } from '../src/parse.js';

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

describe('dify parse', () => {
  it('parses workflow mode and extracts typed inputs', () => {
    const p = parseDsl(DSL);
    expect(p.mode).toBe('workflow');
    const inputs = extractInputs(p.nodes);
    expect(inputs).toEqual([
      {
        key: 'topic',
        label: '主题',
        type: 'string',
        widget: 'text',
        required: true,
        maxLength: 100,
      },
      {
        key: 'tone',
        label: '语气',
        type: 'enum',
        widget: 'select',
        options: ['活泼', '专业', '种草'],
        default: '活泼',
      },
    ]);
  });

  it('extracts outputs with inferred types', () => {
    const p = parseDsl(DSL);
    const outputs = extractOutputs(p.nodes);
    expect(outputs[0]).toMatchObject({ key: 'caption', type: 'string' });
    expect(outputs[1]).toMatchObject({ key: 'image_url' });
  });

  it('rejects advanced-chat mode', () => {
    expect(() => parseDsl(DSL.replace('mode: workflow', 'mode: advanced-chat'))).toThrow(
      /unsupported_mode/,
    );
  });

  it('rejects non-app kind', () => {
    expect(() => parseDsl(DSL.replace('kind: app', 'kind: dataset'))).toThrow(/invalid_dsl/);
  });

  it('rejects malformed yaml that is not a record', () => {
    expect(() => parseDsl('just a string')).toThrow(DifyParseError);
  });

  it('rejects a DSL with no start node', () => {
    const noStart = `
app: { mode: workflow, name: x }
kind: app
version: "0.1.0"
workflow:
  graph:
    nodes:
      - { id: end, data: { type: end, outputs: [] } }
`;
    const p = parseDsl(noStart);
    expect(() => extractInputs(p.nodes)).toThrow(/invalid_dsl/);
  });

  it('maps paragraph, number, file, and file-list inputs', () => {
    const dsl = `
app: { mode: workflow, name: x }
kind: app
version: "0.1.0"
workflow:
  graph:
    nodes:
      - { id: start, data: { type: start, variables: [
            { variable: body,    label: 正文, type: paragraph },
            { variable: count,   label: 数量, type: number },
            { variable: cover,   label: 封面, type: file },
            { variable: gallery, label: 相册, type: file-list } ] } }
`;
    const p = parseDsl(dsl);
    expect(extractInputs(p.nodes)).toEqual([
      { key: 'body', label: '正文', type: 'string', widget: 'textarea' },
      { key: 'count', label: '数量', type: 'number', widget: 'number' },
      { key: 'cover', label: '封面', type: 'file', widget: 'file-upload' },
      { key: 'gallery', label: '相册', type: 'file_list', widget: 'multi-file-upload' },
    ]);
  });

  it('infers code-node output type and marks render unconfirmed', () => {
    const dsl = `
app: { mode: workflow, name: x }
kind: app
version: "0.1.0"
workflow:
  graph:
    nodes:
      - { id: start, data: { type: start, variables: [] } }
      - { id: code1, data: { type: code, outputs: { score: { type: number } } } }
      - { id: end, data: { type: end, outputs: [
            { variable: score, value_selector: [code1, score] } ] } }
`;
    const p = parseDsl(dsl);
    const outputs = extractOutputs(p.nodes);
    expect(outputs[0]).toEqual({
      key: 'score',
      type: 'number',
      render: 'text',
      renderConfirmed: false,
    });
  });
});
