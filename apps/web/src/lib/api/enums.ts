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
