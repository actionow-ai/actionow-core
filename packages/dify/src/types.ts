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
