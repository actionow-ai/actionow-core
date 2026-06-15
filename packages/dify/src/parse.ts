import { parse as parseYaml } from 'yaml';

import { DifyParseError } from './errors.js';
import { asArray, asRecord, asString, recordAt } from './internal/guards.js';
import type { DifyNode, ParsedDsl } from './types.js';

/**
 * Parse a Dify workflow DSL document into a {@link ParsedDsl}.
 *
 * Validates the envelope defensively (external YAML): the document must be a
 * record with `kind: app`; `app.mode` must be `workflow` (first期 does not
 * support `advanced-chat`); `workflow.graph.nodes` must be an array. Any
 * violation throws a typed {@link DifyParseError}.
 */
export function parseDsl(yamlText: string): ParsedDsl {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText) as unknown;
  } catch (cause) {
    throw new DifyParseError('invalid_dsl', `YAML parse failed: ${stringifyCause(cause)}`);
  }

  const raw = asRecord(parsed);
  if (raw === undefined) {
    throw new DifyParseError('invalid_dsl', 'DSL root is not a mapping');
  }

  if (asString(raw.kind) !== 'app') {
    throw new DifyParseError('invalid_dsl', "DSL `kind` must be 'app'");
  }

  const version = asString(raw.version);
  if (version === undefined) {
    throw new DifyParseError('invalid_dsl', 'DSL `version` must be a string');
  }

  const app = recordAt(raw, 'app');
  if (app === undefined) {
    throw new DifyParseError('invalid_dsl', 'DSL `app` must be a mapping');
  }

  const mode = asString(app.mode);
  if (mode !== 'workflow') {
    throw new DifyParseError(
      'unsupported_mode',
      `only 'workflow' is supported (got ${String(mode)})`,
    );
  }

  const nodesRaw = asArray(recordAt(recordAt(raw, 'workflow'), 'graph')?.nodes);
  if (nodesRaw === undefined) {
    throw new DifyParseError('invalid_dsl', 'workflow.graph.nodes must be an array');
  }
  const nodes: DifyNode[] = [];
  for (const node of nodesRaw) {
    const record = asRecord(node);
    if (record !== undefined) {
      nodes.push(record);
    }
  }

  return {
    mode: 'workflow',
    version,
    name: asString(app.name),
    icon: asString(app.icon),
    nodes,
    raw,
  };
}

function stringifyCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
