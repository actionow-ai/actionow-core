/**
 * Pure shape helpers for the `ioSchema` builder. Mirrors the backend
 * `packages/contracts/io-schema` `IoField` shape. `cleanField` normalizes one
 * row (trim key/label, keep `options` only for `enum`, keep a positive
 * `maxLength` only for `string`/`file`); `buildIoSchema` drops blank-key rows
 * and cleans the rest into the `{ inputs, outputs }` the API expects.
 */
export const IO_TYPES = ['string', 'number', 'boolean', 'enum', 'file', 'file_list'] as const;
export type IoType = (typeof IO_TYPES)[number];

export interface IoField {
  key: string;
  type: IoType;
  label?: string;
  required?: boolean;
  default?: unknown;
  options?: string[];
  maxLength?: number;
}

export function emptyIoField(): IoField {
  return { key: '', type: 'string', required: false };
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
