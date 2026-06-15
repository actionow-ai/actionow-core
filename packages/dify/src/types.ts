import type { IoField } from '@actionow/contracts';

/**
 * A single graph node from a Dify workflow DSL. The DSL is external YAML, so we
 * keep the node as a narrowed record and read fields defensively via the guards
 * in `internal/guards.ts` rather than trusting a hand-written shape.
 */
export type DifyNode = Record<string, unknown>;

/** Supported app modes. First期 only `workflow` (not `advanced-chat`). */
export type DifyMode = 'workflow';

/**
 * The result of {@link parseDsl}: the validated envelope fields plus the raw
 * parsed document (for the compat report to walk `dependencies` etc.).
 */
export interface ParsedDsl {
  readonly mode: DifyMode;
  readonly version: string;
  readonly name: string | undefined;
  readonly icon: string | undefined;
  readonly nodes: readonly DifyNode[];
  readonly raw: Record<string, unknown>;
}

/**
 * An extracted output field. Extends the unified {@link IoField} with
 * `renderConfirmed`: the parser only best-guesses the render hint, a human
 * confirms it at import time.
 */
export interface DifyOutputField extends IoField {
  readonly renderConfirmed: boolean;
}

/** Classification of a single graph element in the compat & cost report. */
export type CompatItemKind =
  | 'model_known'
  | 'model_unknown'
  | 'tool_needs_credentials'
  | 'knowledge_reference'
  | 'external_http'
  | 'code_node'
  | 'missing_plugin';

/** Severity of a compat item. `block` items make the whole report a blocker. */
export type CompatSeverity = 'ok' | 'warn' | 'block';

export interface CompatItem {
  readonly kind: CompatItemKind;
  readonly severity: CompatSeverity;
  readonly detail: string;
  /**
   * The bare identifier the item refers to (model `provider/name`, tool name,
   * plugin id), when one is known. `requiredSecrets` is built from the `ref`s of
   * `tool_needs_credentials` items.
   */
  readonly ref?: string;
}

export interface CompatReport {
  readonly items: readonly CompatItem[];
  readonly hasBlockers: boolean;
}
