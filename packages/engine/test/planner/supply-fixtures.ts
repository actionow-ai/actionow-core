// Shared handwritten fixtures for the slice-3a planner tests (candidates /
// sort): type-complete RoutingCandidate / credential / breaker rows so the
// fake queries return exactly what the slice-1 repo functions would — no live
// db anywhere.
import type {
  BillingDims,
  CanonicalParam,
  EffectiveParams,
  FetchMode,
  ModelOperation,
  OfferingParamDecl,
  Operation,
  Paradigm,
} from '@actionow/contracts';
import type { RoutingCandidate, SupplyCredentialRow, SupplyOfferingBreakerRow } from '@actionow/db';

import type { AssembledCandidate } from '../../src/planner/index.js';

/** A fixed base instant for created_at/updated_at bookkeeping fields. */
export const T0 = new Date('2026-07-01T00:00:00.000Z');

/** The planner clock every test judges against. */
export const NOW = new Date('2026-07-12T12:00:00.000Z');

export function offering(o: {
  id: string;
  channelId?: string;
  tier?: number;
  weight?: number;
  mode?: FetchMode;
  declarations?: OfferingParamDecl[];
}): RoutingCandidate {
  const channelId = o.channelId ?? 'chan-1';
  return {
    id: o.id,
    modelId: 'model-1',
    channelId,
    status: 'enabled',
    upstreamModelName: `up-${o.id}`,
    fetchProfile: { mode: o.mode ?? 'direct' },
    timeoutBudgetSeconds: null,
    paramDeclarations: o.declarations ?? [],
    costPriceCardId: null,
    maxConcurrency: null,
    weight: o.weight ?? 1,
    tier: o.tier ?? 0,
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    channel: {
      id: channelId,
      tenantId: null,
      providerId: 'prov-1',
      tags: [],
      routeGroupId: null,
      dialect: null,
      baseUrl: null,
      proxyRef: null,
      authScheme: 'bearer',
      region: null,
      status: 'active',
    },
  };
}

export function credential(id: string, channelId: string): SupplyCredentialRow {
  return {
    id,
    channelId,
    name: `key-${id}`,
    secretRefId: `ref-${id}`,
    secretHint: null,
    quota: { rpm: null, tpm: null, max_concurrency: null },
    status: 'active',
    cooldownUntil: null,
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
  };
}

export function breakerRow(
  offeringId: string,
  o: {
    state: string;
    openedAt?: Date | null;
    halfOpenSuccesses?: number;
    consecutiveOpens?: number;
  },
): SupplyOfferingBreakerRow {
  return {
    offeringId,
    state: o.state,
    openedAt: o.openedAt ?? null,
    halfOpenSuccesses: o.halfOpenSuccesses ?? 0,
    consecutiveOpens: o.consecutiveOpens ?? 0,
    updatedAt: T0,
  };
}

export function modelOp(
  operation: Operation,
  o: { paradigms?: Paradigm[]; slow?: boolean; params?: CanonicalParam[] } = {},
): ModelOperation {
  return {
    operation,
    paradigms: o.paradigms ?? ['sync'],
    slow: o.slow ?? false,
    params: o.params ?? [],
  };
}

const EMPTY_EFFECTIVE: EffectiveParams = { canonical: {}, upstream: {} };
const EMPTY_DIMS: BillingDims = {};

/** Wrap an offering as a post-assembly candidate (sort.ts input). */
export function assembled(candidate: RoutingCandidate): AssembledCandidate {
  return {
    offering: candidate,
    effective: EMPTY_EFFECTIVE,
    billingDims: EMPTY_DIMS,
    activeCredentialCount: 1,
  };
}
