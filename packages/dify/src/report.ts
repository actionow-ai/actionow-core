import { asArray, asRecord, asString, recordAt } from './internal/guards.js';
import type {
  CompatItem,
  CompatItemKind,
  CompatReport,
  CompatSeverity,
  DifyNode,
  ParsedDsl,
} from './types.js';

export interface CompatReportOptions {
  /** Set of `provider/name` keys for models we already have a mapping for. */
  readonly knownModels: ReadonlySet<string>;
}

/** Node `data.type`s that carry a model reference (`data.model.{provider,name}`). */
const MODEL_NODE_TYPES: ReadonlySet<string> = new Set([
  'llm',
  'agent',
  'parameter-extractor',
  'question-classifier',
]);

/** Node `data.type`s that reference a workspace dataset — blocked首期 (§7.4). */
const KNOWLEDGE_NODE_TYPES: ReadonlySet<string> = new Set(['knowledge-retrieval', 'datasource']);

function nodeData(node: DifyNode): Record<string, unknown> | undefined {
  return recordAt(node, 'data');
}

function nodeId(node: DifyNode): string {
  return asString(node.id) ?? '(anonymous)';
}

function classifyModelNode(node: DifyNode, knownModels: ReadonlySet<string>): CompatItem {
  const model = recordAt(nodeData(node), 'model');
  const provider = asString(model?.provider);
  const name = asString(model?.name);
  const ref = provider !== undefined && name !== undefined ? `${provider}/${name}` : undefined;
  const id = nodeId(node);

  if (ref !== undefined && knownModels.has(ref)) {
    return item('model_known', 'warn', `node ${id}: model ${ref} is mapped`, ref);
  }
  return item(
    'model_unknown',
    'warn',
    `node ${id}: model ${ref ?? '(unspecified)'} needs a mapping`,
    ref,
  );
}

function item(
  kind: CompatItemKind,
  severity: CompatSeverity,
  detail: string,
  ref?: string,
): CompatItem {
  // `exactOptionalPropertyTypes`: only attach `ref` when one is known, never as
  // an explicit `undefined`.
  return ref === undefined ? { kind, severity, detail } : { kind, severity, detail, ref };
}

/**
 * Walk a parsed workflow's graph nodes and top-level `dependencies` and produce
 * a compat & cost report. Each element is classified and assigned a severity:
 *
 * - model nodes (`llm`/`agent`/`parameter-extractor`/`question-classifier`):
 *   `model_known` (in `knownModels`) or `model_unknown` — both `warn`.
 * - `tool` → `tool_needs_credentials` (`warn`; the DSL carries no secrets).
 * - `knowledge-retrieval`/`datasource` → `knowledge_reference` — **`block`**
 *   首期 (§7.4: reject knowledge-dependent workflows).
 * - `http-request` → `external_http` (`warn`; SSRF / cost-opaque).
 * - `code` → `code_node` (`warn`; sandbox).
 * - top-level `dependencies` (plugins) → `missing_plugin` (`warn`).
 *
 * `hasBlockers` is true iff any item is `block`.
 */
export function buildCompatReport(parsed: ParsedDsl, opts: CompatReportOptions): CompatReport {
  const items: CompatItem[] = [];

  for (const node of parsed.nodes) {
    const type = asString(nodeData(node)?.type);
    if (type === undefined) {
      continue;
    }
    const id = nodeId(node);

    if (MODEL_NODE_TYPES.has(type)) {
      items.push(classifyModelNode(node, opts.knownModels));
      continue;
    }
    if (type === 'tool') {
      const toolName =
        asString(nodeData(node)?.tool_name) ?? asString(nodeData(node)?.provider_name) ?? id;
      items.push(
        item(
          'tool_needs_credentials',
          'warn',
          `node ${id}: tool '${toolName}' may need credentials (none in DSL)`,
          toolName,
        ),
      );
      continue;
    }
    if (KNOWLEDGE_NODE_TYPES.has(type)) {
      items.push(
        item(
          'knowledge_reference',
          'block',
          `node ${id}: '${type}' references a source-workspace dataset (unsupported首期)`,
        ),
      );
      continue;
    }
    if (type === 'http-request') {
      const url = asString(nodeData(node)?.url) ?? '(dynamic)';
      items.push(
        item(
          'external_http',
          'warn',
          `node ${id}: external HTTP request to ${url} (SSRF/cost-opaque)`,
        ),
      );
      continue;
    }
    if (type === 'code') {
      items.push(item('code_node', 'warn', `node ${id}: code node runs in the sandbox`));
      continue;
    }
  }

  for (const dep of asArray(parsed.raw.dependencies) ?? []) {
    const record = asRecord(dep);
    if (record === undefined) {
      continue;
    }
    const value = asRecord(record.value);
    const ident =
      asString(value?.plugin_unique_identifier) ??
      asString(record.value) ??
      asString(record.type) ??
      '(unknown plugin)';
    items.push(item('missing_plugin', 'warn', `dependency '${ident}' must be installed`, ident));
  }

  return {
    items,
    hasBlockers: items.some((i) => i.severity === 'block'),
  };
}
