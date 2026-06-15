import type { IoField } from '@actionow/contracts';

import { DifyParseError } from './errors.js';
import { dslHash } from './hash.js';
import { extractInputs, extractOutputs } from './io-schema.js';
import { parseDsl } from './parse.js';
import { buildCompatReport } from './report.js';
import type { CompatReport } from './types.js';

/**
 * Provision mode of a registered workflow. First期 only `byo` (bring-your-own
 * Dify endpoint + key); managed provision is out of scope.
 */
export type ProvisionMode = 'byo';

/**
 * Binding-level pricing model. `metered` is forbidden for `byo` (review #2 /
 * §7.3): BYO cannot observe gateway-side sub-calls, so metering is unavailable.
 */
export type PricingModel = 'fixed' | 'matrix' | 'metered';

export interface ResourceDraftOptions {
  readonly resourceId: string;
  readonly provisionMode: ProvisionMode;
  readonly pricingModel: PricingModel;
  /** `provider/name` keys for models that already have a mapping. */
  readonly knownModels: ReadonlySet<string>;
}

export interface ResourceDraft {
  readonly resourceId: string;
  readonly mode: 'workflow';
  readonly providerType: 'dify-workflow';
  readonly modality: 'composite';
  readonly ioSchema: {
    readonly inputs: readonly IoField[];
    readonly outputs: readonly IoField[];
  };
  readonly dslHash: string;
  readonly compatReport: CompatReport;
  readonly provisionMode: ProvisionMode;
  readonly pricingModel: PricingModel;
  /** Tool nodes that need credentials (derived from the compat report). */
  readonly requiredSecrets: readonly string[];
}

/**
 * Parse a Dify workflow DSL and assemble a {@link ResourceDraft}: the io_schema
 * (inputs + outputs), the compat & cost report, the content hash, and the
 * binding fields to persist.
 *
 * Enforces the焊死 constraint (review #2 / §7.3): a `byo` workflow may not use
 * `metered` pricing — throws `DifyParseError('metered_not_allowed')`.
 *
 * The draft is returned even when the compat report has blockers; the caller
 * (the registration service) decides whether to reject or allow them.
 */
export function buildResourceDraft(yamlText: string, opts: ResourceDraftOptions): ResourceDraft {
  // 焊死 constraint (review #2 / §7.3): BYO + metered is invalid. The
  // `provisionMode === 'byo'` check is currently always-true (BYO is the only
  // mode首期) but is kept explicit to document intent and stay correct when a
  // managed provision mode is added.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (opts.provisionMode === 'byo' && opts.pricingModel === 'metered') {
    throw new DifyParseError(
      'metered_not_allowed',
      'BYO workflows cannot use metered pricing — use fixed/matrix',
    );
  }

  const parsed = parseDsl(yamlText);
  const inputs = extractInputs(parsed.nodes);
  const outputs = extractOutputs(parsed.nodes);
  const compatReport = buildCompatReport(parsed, { knownModels: opts.knownModels });

  const requiredSecrets = compatReport.items
    .filter((i) => i.kind === 'tool_needs_credentials')
    .map((i) => i.ref ?? i.detail);

  return {
    resourceId: opts.resourceId,
    mode: 'workflow',
    providerType: 'dify-workflow',
    modality: 'composite',
    ioSchema: { inputs, outputs },
    dslHash: dslHash(yamlText),
    compatReport,
    provisionMode: opts.provisionMode,
    pricingModel: opts.pricingModel,
    requiredSecrets,
  };
}
