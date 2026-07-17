// packages/engine/src/planner/sort.ts
//
// model-supply-greenfield 批次3 slice 3a — §8 排序:
//
//   排序 = tier 降序 + 权重随机 + 可恢复 fetch 加权
//
// Implemented by REUSING the proven adapters ordering primitive
// (orderForFailover: priority tiers HIGHEST-first, weighted random pick inside
// each tier, then the rest by descending weight) rather than a second
// implementation. The §3 recoverable-fetch preference (routing 排序在同模型多
// 供给项间对可恢复 fetch 模式 submit_poll/submit_callback 给予优先权重) is
// encoded as a SUB-TIER: within one offering tier the recoverable candidates
// form the higher sub-tier and are exhausted before the direct/stream ones;
// weight randomization still applies inside each sub-tier. The bonus can never
// cross offering tiers — tier stays the first-order key.
import { orderForFailover, type WeightedChannel } from '@actionow/adapters';

import type { AssembledCandidate } from './candidates.js';
import { isRecoverableFetchMode } from './fetch-plan.js';

export interface SortOptions {
  /**
   * Uniform RNG in [0, 1) for the same-tier weighted pick. Inject a
   * deterministic one in tests; absent → Math.random. (Engine convention:
   * always injectable — some runtimes forbid Math.random.)
   */
  rng?: (() => number) | undefined;
}

/**
 * §8 candidate ordering over an {@link assembleCandidates} survivor set:
 * offering tier DESC first, recoverable fetch modes (submit_poll /
 * submit_callback) ahead of direct/stream WITHIN a tier (§3 加权), weighted
 * random pick + weight-desc rest inside each sub-tier. Pure: does not mutate
 * the input array.
 *
 * Servability interplay (§3): assembly's isServable filter runs BEFORE this
 * sort, so every candidate here can already serve the planned paradigm — the
 * recoverable bonus only reorders WITHIN the servable set. It can never
 * surface an unservable pairing (e.g. push a submit offering ahead of a
 * stream request's stream/direct supply: those submits never reach the sort).
 */
export function sortCandidates(
  candidates: readonly AssembledCandidate[],
  opts: SortOptions = {},
): AssembledCandidate[] {
  const rng = opts.rng ?? Math.random;
  const weighted: WeightedChannel<AssembledCandidate>[] = candidates.map((candidate) => ({
    id: candidate.offering.id,
    weight: candidate.offering.weight,
    priority: sortPriority(candidate),
    value: candidate,
  }));
  return orderForFailover(weighted, rng).map((entry) => entry.value);
}

/**
 * The composite priority key: `tier × 2 + recoverableBit`. orderForFailover
 * tries HIGHER priority first, so each offering tier splits into two adjacent
 * sub-tiers — recoverable (`2t + 1`) above non-recoverable (`2t`) — while any
 * higher tier's sub-tiers (`≥ 2(t+1)`) stay strictly above both (the §3 bonus
 * never flips tiers, negative tiers included).
 */
function sortPriority(candidate: AssembledCandidate): number {
  const recoverable = isRecoverableFetchMode(candidate.offering.fetchProfile.mode);
  return candidate.offering.tier * 2 + (recoverable ? 1 : 0);
}
