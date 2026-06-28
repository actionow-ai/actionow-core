/**
 * Pure shape helpers for the `ioSchema` builder. Mirrors the backend
 * `packages/contracts/io-schema` `IoField` shape. `cleanField` normalizes one
 * row (trim key/label, keep `options` only for `enum`, keep a positive
 * `maxLength` only for `string`/`file`); `buildIoSchema` drops blank-key rows
 * and cleans the rest into the `{ inputs, outputs }` the API expects.
 *
 * `id` is an editor-only stable React key (minted by `emptyIoField`) so removing
 * a middle field row doesn't strand the surviving rows' focus. `cleanField`
 * rebuilds a fresh object and never copies it, so it never reaches the backend.
 */
import type { IoField as ContractIoField, IoType as ContractIoType } from '@actionow/contracts';

import { rowId } from '../../lib/rowId';

export const IO_TYPES = ['string', 'number', 'boolean', 'enum', 'file', 'file_list'] as const;
export type IoType = (typeof IO_TYPES)[number];

export interface IoField {
  /** Editor-only stable React key; never serialized to the backend. */
  id?: string;
  key: string;
  type: IoType;
  label?: string;
  required?: boolean;
  default?: unknown;
  options?: string[];
  maxLength?: number;
}

// --- Contract drift guards (compile-time only) -----------------------------
// This editor IoField is a HAND-WRITTEN mirror of the contract's `ioFieldSchema`
// (hand-written on purpose so the browser bundle never pulls in Zod — the import
// above is `import type`, which `verbatimModuleSyntax` erases). The assertions
// below fail the build the moment the two drift apart: the IO-type set must match
// the contract's, and a cleaned wire field (sans the editor-only `id`) must stay a
// valid contract field — so a contract change that adds a required field or retypes
// a shared one can't ship a silently-wrong payload. `widget`/`render` are contract
// fields this editor doesn't expose; that's fine (they're optional + omitted).
type Expect<T extends true> = T;

// IO_TYPES must equal the contract's enum — mutual assignability is set equality
// for these string-literal unions (a drifted local set fails one direction).
export type AssertIoTypeMatchesContract = Expect<
  IoType extends ContractIoType ? (ContractIoType extends IoType ? true : false) : false
>;
// A cleaned wire field (sans the editor-only `id`) must remain assignable to the
// contract field — a contract change that adds a required field or retypes a
// shared one fails here.
export type AssertWireFieldMatchesContract = Expect<
  Omit<IoField, 'id'> extends ContractIoField ? true : false
>;

export function emptyIoField(): IoField {
  return { id: rowId(), key: '', type: 'string', required: false };
}

export function cleanField(f: IoField): IoField {
  const out: IoField = { key: f.key.trim(), type: f.type, required: f.required ?? false };
  if (f.label !== undefined && f.label.trim() !== '') out.label = f.label.trim();
  if (f.type === 'enum' && f.options !== undefined && f.options.length > 0) out.options = f.options;
  if (
    typeof f.maxLength === 'number' &&
    f.maxLength > 0 &&
    (f.type === 'string' || f.type === 'file')
  ) {
    out.maxLength = f.maxLength;
  }
  if (f.default !== undefined) out.default = f.default;
  return out;
}

export function buildIoSchema(
  inputs: IoField[],
  outputs: IoField[],
): { inputs: IoField[]; outputs: IoField[] } {
  return {
    inputs: inputs.filter((f) => f.key.trim() !== '').map(cleanField),
    outputs: outputs.filter((f) => f.key.trim() !== '').map(cleanField),
  };
}
