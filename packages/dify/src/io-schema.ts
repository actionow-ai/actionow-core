import type { IoField, IoType } from '@actionow/contracts';

import { DifyParseError } from './errors.js';
import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  asStringArray,
  recordAt,
} from './internal/guards.js';
import type { DifyNode, DifyOutputField } from './types.js';

/** Mapping from a Dify Start-variable `type` to the unified io_schema type + widget. */
interface InputMapping {
  readonly type: IoType;
  readonly widget: string;
}

const INPUT_TYPE_MAP: Readonly<Record<string, InputMapping>> = {
  'text-input': { type: 'string', widget: 'text' },
  paragraph: { type: 'string', widget: 'textarea' },
  select: { type: 'enum', widget: 'select' },
  number: { type: 'number', widget: 'number' },
  file: { type: 'file', widget: 'file-upload' },
  'file-list': { type: 'file_list', widget: 'multi-file-upload' },
};

function nodeData(node: DifyNode): Record<string, unknown> | undefined {
  return recordAt(node, 'data');
}

function nodeDataType(node: DifyNode): string | undefined {
  return asString(nodeData(node)?.type);
}

function findNodeByDataType(nodes: readonly DifyNode[], dataType: string): DifyNode | undefined {
  return nodes.find((n) => nodeDataType(n) === dataType);
}

function findNodeById(nodes: readonly DifyNode[], id: string): DifyNode | undefined {
  return nodes.find((n) => asString(n.id) === id);
}

/**
 * Extract the typed input fields from the workflow's Start node. Maps each
 * declared variable's Dify `type` to the unified io_schema type + widget per the
 * §7.1 table. Missing Start node → `invalid_dsl`. Variables with an unknown
 * `type` are skipped (they surface in the compat report, not here).
 */
export function extractInputs(nodes: readonly DifyNode[]): IoField[] {
  const start = findNodeByDataType(nodes, 'start');
  if (start === undefined) {
    throw new DifyParseError('invalid_dsl', 'workflow has no start node');
  }

  const variables = asArray(nodeData(start)?.variables) ?? [];
  const fields: IoField[] = [];

  for (const raw of variables) {
    const v = asRecord(raw);
    if (v === undefined) {
      continue;
    }
    const key = asString(v.variable);
    const difyType = asString(v.type);
    if (key === undefined || difyType === undefined) {
      continue;
    }
    const mapping = INPUT_TYPE_MAP[difyType];
    if (mapping === undefined) {
      continue;
    }

    const field: IoField = { key, type: mapping.type, widget: mapping.widget };

    const label = asString(v.label);
    if (label !== undefined) {
      field.label = label;
    }
    const required = asBoolean(v.required);
    if (required !== undefined) {
      field.required = required;
    }

    if (difyType === 'text-input') {
      const maxLength = asNumber(v.max_length);
      if (maxLength !== undefined && Number.isInteger(maxLength) && maxLength > 0) {
        field.maxLength = maxLength;
      }
    }

    if (difyType === 'select') {
      const options = asStringArray(v.options);
      if (options !== undefined) {
        field.options = options;
      }
      const def = asString(v.default);
      if (def !== undefined) {
        field.default = def;
      }
    }

    fields.push(field);
  }

  return fields;
}

/**
 * Infer the unified output type by following an End output's `value_selector`
 * (`[nodeId, field]`) back to the referenced node:
 * - `llm` → string
 * - `code` → the code node's declared output type if present, else string
 * - `tool` (and anything else) → string (default)
 */
function inferOutputType(nodes: readonly DifyNode[], nodeId: string, field: string): IoType {
  const ref = findNodeById(nodes, nodeId);
  const refType = ref === undefined ? undefined : nodeDataType(ref);

  if (refType === 'code') {
    const declared = recordAt(nodeData(ref ?? {}), 'outputs')?.[field];
    const declaredType = asString(asRecord(declared)?.type);
    return mapCodeOutputType(declaredType);
  }

  // llm, tool, and every other node type default to string.
  return 'string';
}

function mapCodeOutputType(declared: string | undefined): IoType {
  switch (declared) {
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array[string]':
    case 'array[file]':
      return 'file_list';
    default:
      return 'string';
  }
}

/**
 * Best-guess a render hint from the output variable name. Always returned with
 * `renderConfirmed: false` — a human confirms the render at import time.
 */
function guessRender(variable: string): string {
  const lower = variable.toLowerCase();
  if (/(image|img|photo|cover|picture|thumbnail)/.test(lower)) {
    return 'image';
  }
  if (/(file|doc|attachment|pdf|video|audio)/.test(lower)) {
    return 'file';
  }
  return 'text';
}

/**
 * Extract the typed output fields from the workflow's End node. Each output's
 * type is inferred by following its `value_selector` to the referenced node
 * (see {@link inferOutputType}); the render hint is a best guess marked
 * `renderConfirmed: false`. Missing End node → empty list.
 */
export function extractOutputs(nodes: readonly DifyNode[]): DifyOutputField[] {
  const end = findNodeByDataType(nodes, 'end');
  if (end === undefined) {
    return [];
  }

  const outputs = asArray(nodeData(end)?.outputs) ?? [];
  const fields: DifyOutputField[] = [];

  for (const raw of outputs) {
    const o = asRecord(raw);
    if (o === undefined) {
      continue;
    }
    const key = asString(o.variable);
    if (key === undefined) {
      continue;
    }
    const selector = asArray(o.value_selector);
    const nodeId = asString(selector?.[0]);
    const refField = asString(selector?.[1]);

    const type =
      nodeId !== undefined && refField !== undefined
        ? inferOutputType(nodes, nodeId, refField)
        : 'string';

    fields.push({
      key,
      type,
      render: guessRender(key),
      renderConfirmed: false,
    });
  }

  return fields;
}
