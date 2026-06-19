import type { ChannelStatus, Modality, PricebookMethod, PricebookTiming } from './types';

/**
 * A single enum option: the literal backend `value` plus the i18n `labelKey`
 * that resolves to its display label. `toOptions` turns these into the
 * `{ value, label }` shape `SelectField`/`Select` expect by mapping `labelKey`
 * through `t`. This keeps the option sets the single source of truth shared
 * with the `types.ts` union literals (no free-text → enum coercion).
 */
export interface EnumOption<V extends string = string> {
  value: V;
  labelKey: string;
}

export const MODALITIES: EnumOption<Modality>[] = [
  { value: 'text', labelKey: 'enums.modality.text' },
  { value: 'image', labelKey: 'enums.modality.image' },
  { value: 'video', labelKey: 'enums.modality.video' },
  { value: 'audio', labelKey: 'enums.modality.audio' },
  { value: 'composite', labelKey: 'enums.modality.composite' },
];

export const RESOURCE_KINDS: EnumOption<'model' | 'workflow'>[] = [
  { value: 'model', labelKey: 'enums.kind.model' },
  { value: 'workflow', labelKey: 'enums.kind.workflow' },
];

export const PRICEBOOK_METHODS: EnumOption<PricebookMethod>[] = [
  { value: 'unit', labelKey: 'enums.method.unit' },
  { value: 'matrix', labelKey: 'enums.method.matrix' },
  { value: 'fixed', labelKey: 'enums.method.fixed' },
  { value: 'formula', labelKey: 'enums.method.formula' },
  { value: 'passthrough', labelKey: 'enums.method.passthrough' },
];

export const PRICEBOOK_TIMINGS: EnumOption<PricebookTiming>[] = [
  { value: 'pre', labelKey: 'enums.timing.pre' },
  { value: 'post', labelKey: 'enums.timing.post' },
];

export const CHANNEL_STATUSES: EnumOption<ChannelStatus>[] = [
  { value: 'active', labelKey: 'enums.channelStatus.active' },
  { value: 'disabled', labelKey: 'enums.channelStatus.disabled' },
];

export const MARKUP_TYPES: EnumOption<'percent' | 'flat'>[] = [
  { value: 'percent', labelKey: 'enums.markupType.percent' },
  { value: 'flat', labelKey: 'enums.markupType.flat' },
];

/** Model visibility: `public` = open to all tenants; `tenant` = grant-gated. */
export const VISIBILITIES: EnumOption<'public' | 'tenant'>[] = [
  { value: 'public', labelKey: 'enums.visibility.public' },
  { value: 'tenant', labelKey: 'enums.visibility.tenant' },
];

export const MODEL_STATUSES: EnumOption<'active' | 'disabled'>[] = [
  { value: 'active', labelKey: 'enums.modelStatus.active' },
  { value: 'disabled', labelKey: 'enums.modelStatus.disabled' },
];

/** A known capability flag, surfaced as a toggle (editor) / chip (table). */
export interface CapabilityDef {
  key: string;
  labelKey: string;
}

/**
 * Known model capability flags. The set is open-ended (`capabilities` is a
 * free-form `Record<string,boolean>`); these are the common ones the UI labels
 * and chips. Unknown flags are preserved and shown by their raw key.
 */
export const CAPABILITIES: CapabilityDef[] = [
  { key: 'tools', labelKey: 'enums.capability.tools' },
  { key: 'vision', labelKey: 'enums.capability.vision' },
  { key: 'audio', labelKey: 'enums.capability.audio' },
  { key: 'json', labelKey: 'enums.capability.json' },
  { key: 'stream', labelKey: 'enums.capability.stream' },
];

/** Common upstream provider identifiers — suggestions for free-text fields (not an enum). */
export const COMMON_PROVIDERS = [
  'openai',
  'anthropic',
  'gemini',
  'azure',
  'bedrock',
  'cohere',
  'mistral',
] as const;

/** Known exec-mode values — suggestions for the resource `execModes` chips field. */
export const EXEC_MODES = ['blocking', 'stream', 'async-poll', 'async-callback'] as const;

/** Map enum options to `{ value, label }`, resolving each `labelKey` via `t`. */
export function toOptions<V extends string>(
  opts: EnumOption<V>[],
  t: (key: string) => string,
): { value: V; label: string }[] {
  return opts.map((o) => ({ value: o.value, label: t(o.labelKey) }));
}

/**
 * Resolve a single backend enum `value` to its translated label via the matching
 * option's `labelKey`. Unknown values (the option sets are intentionally
 * open-ended — e.g. capabilities, providers) fall back to the raw value so a new
 * backend constant still renders legibly instead of breaking. Use this anywhere a
 * raw enum would otherwise be rendered in English (table cells, detail rows).
 */
export function enumLabel(t: (key: string) => string, opts: EnumOption[], value: string): string {
  const opt = opts.find((o) => o.value === value);
  return opt ? t(opt.labelKey) : value;
}
