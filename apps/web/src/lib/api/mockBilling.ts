// MOCK — replace with real /admin/... client methods when the billing backend
// track lands. The billing/channel-routing backend is DESIGN-ONLY today (and the
// live relay backend is mid-rework), so the 官方价格 / 分组 console pages run on
// this in-memory module instead. Every export mirrors the shape a real API
// client method would have (async, returns plain views) so the future swap to
// `/admin/official-prices` + `/admin/groups` is a single-file change.
//
// Units: prices are integer µUSD per 1M tokens ($1 = 1,000,000 µUSD) per the
// billing spec — these are brand-new reference figures, NOT the live
// µcredit/token registry, so they are intentionally decoupled.

import type { OfficialModelPrice, RouteGroup, RouteGroupChannel } from './types';

/** A simulated network round-trip so the UI exercises its loading states. */
const LATENCY_MS = 120;
const delay = <T>(value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), LATENCY_MS));

// A module-level counter for ids — deterministic and independent of
// Date.now()/Math.random (which may be unavailable or non-deterministic). The
// browser's crypto.randomUUID would also work; a counter keeps demo ids stable.
let idSeq = 0;
const nextId = (prefix: string): string => {
  idSeq += 1;
  return `${prefix}_${String(idSeq).padStart(4, '0')}`;
};

/** µUSD helper: dollars → integer µUSD per 1M ($3 → 3_000_000). */
const usd = (dollars: number): number => Math.round(dollars * 1_000_000);

// --- Seed data ------------------------------------------------------------

const officialPrices: OfficialModelPrice[] = [
  {
    id: nextId('op'),
    provider: 'openai',
    model_slug: 'gpt-4o',
    display_name: 'GPT-4o',
    input_price_per_1m: usd(2.5),
    output_price_per_1m: usd(10),
    cached_input_price_per_1m: usd(1.25),
    source_url: 'https://openai.com/api/pricing/',
    effective_at: '2024-08-06',
    notes: 'Flagship multimodal model.',
    updated_by: 'seed',
    created_at: '2026-06-01T00:00:00.000Z',
  },
  {
    id: nextId('op'),
    provider: 'openai',
    model_slug: 'gpt-4o-mini',
    display_name: 'GPT-4o mini',
    input_price_per_1m: usd(0.15),
    output_price_per_1m: usd(0.6),
    cached_input_price_per_1m: usd(0.075),
    source_url: 'https://openai.com/api/pricing/',
    effective_at: '2024-07-18',
    updated_by: 'seed',
    created_at: '2026-06-01T00:00:00.000Z',
  },
  {
    id: nextId('op'),
    provider: 'anthropic',
    model_slug: 'claude-3-5-sonnet',
    display_name: 'Claude 3.5 Sonnet',
    input_price_per_1m: usd(3),
    output_price_per_1m: usd(15),
    cached_input_price_per_1m: usd(0.3),
    source_url: 'https://www.anthropic.com/pricing',
    effective_at: '2024-10-22',
    updated_by: 'seed',
    created_at: '2026-06-01T00:00:00.000Z',
  },
  {
    id: nextId('op'),
    provider: 'anthropic',
    model_slug: 'claude-3-5-haiku',
    display_name: 'Claude 3.5 Haiku',
    input_price_per_1m: usd(0.8),
    output_price_per_1m: usd(4),
    source_url: 'https://www.anthropic.com/pricing',
    effective_at: '2024-11-04',
    updated_by: 'seed',
    created_at: '2026-06-01T00:00:00.000Z',
  },
  {
    id: nextId('op'),
    provider: 'gemini',
    model_slug: 'gemini-1.5-pro',
    display_name: 'Gemini 1.5 Pro',
    input_price_per_1m: usd(1.25),
    output_price_per_1m: usd(5),
    effective_at: '2024-09-24',
    updated_by: 'seed',
    created_at: '2026-06-01T00:00:00.000Z',
  },
];

const routeGroups: RouteGroup[] = [
  {
    id: nextId('rg'),
    name: 'default',
    group_ratio_bps: 10000,
    status: 'active',
    description: 'Baseline pool — billed at the official price (×1.00).',
    created_at: '2026-06-01T00:00:00.000Z',
  },
  {
    id: nextId('rg'),
    name: 'premium',
    group_ratio_bps: 15000,
    status: 'active',
    description: 'Higher-SLA pool with a +50% markup.',
    created_at: '2026-06-02T00:00:00.000Z',
  },
  {
    id: nextId('rg'),
    name: 'economy',
    group_ratio_bps: 8000,
    status: 'disabled',
    description: 'Discounted overflow pool (-20%), currently paused.',
    created_at: '2026-06-03T00:00:00.000Z',
  },
];

// A small fixed roster of channels the membership picker can choose from. In the
// real backend these would come from `listChannels` per resource.
export interface MockChannel {
  id: string;
  label: string;
}
export const MOCK_CHANNELS: MockChannel[] = [
  { id: 'ch_openai_primary', label: 'openai · primary' },
  { id: 'ch_openai_backup', label: 'openai · backup' },
  { id: 'ch_anthropic_primary', label: 'anthropic · primary' },
  { id: 'ch_gemini_primary', label: 'gemini · primary' },
  { id: 'ch_azure_eastus', label: 'azure · eastus' },
];

const groupChannels: RouteGroupChannel[] = [
  { group_id: 'rg_0006', channel_id: 'ch_openai_primary', priority: 100, weight: 70 },
  { group_id: 'rg_0006', channel_id: 'ch_openai_backup', priority: 50, weight: 30 },
  { group_id: 'rg_0007', channel_id: 'ch_anthropic_primary', priority: 100, weight: 100 },
];

// --- Official prices ------------------------------------------------------

export const listOfficialPrices = (): Promise<OfficialModelPrice[]> =>
  delay(officialPrices.map((p) => ({ ...p })));

export const createOfficialPrice = (
  body: Omit<OfficialModelPrice, 'id' | 'created_at'>,
): Promise<OfficialModelPrice> => {
  const row: OfficialModelPrice = {
    ...body,
    id: nextId('op'),
    created_at: new Date().toISOString(),
  };
  officialPrices.push(row);
  return delay({ ...row });
};

export const updateOfficialPrice = (
  id: string,
  patch: Partial<Omit<OfficialModelPrice, 'id' | 'created_at'>>,
): Promise<OfficialModelPrice> => {
  const row = officialPrices.find((p) => p.id === id);
  if (row === undefined) throw new Error(`mock official price not found: ${id}`);
  Object.assign(row, patch);
  return delay({ ...row });
};

export const deleteOfficialPrice = (id: string): Promise<void> => {
  const i = officialPrices.findIndex((p) => p.id === id);
  if (i >= 0) officialPrices.splice(i, 1);
  return delay(undefined);
};

// --- Route groups ---------------------------------------------------------

export const listRouteGroups = (): Promise<RouteGroup[]> =>
  delay(routeGroups.map((g) => ({ ...g })));

export const createRouteGroup = (
  body: Omit<RouteGroup, 'id' | 'created_at'>,
): Promise<RouteGroup> => {
  const row: RouteGroup = { ...body, id: nextId('rg'), created_at: new Date().toISOString() };
  routeGroups.push(row);
  return delay({ ...row });
};

export const updateRouteGroup = (
  id: string,
  patch: Partial<Omit<RouteGroup, 'id' | 'created_at'>>,
): Promise<RouteGroup> => {
  const row = routeGroups.find((g) => g.id === id);
  if (row === undefined) throw new Error(`mock route group not found: ${id}`);
  Object.assign(row, patch);
  return delay({ ...row });
};

export const deleteRouteGroup = (id: string): Promise<void> => {
  const i = routeGroups.findIndex((g) => g.id === id);
  if (i >= 0) routeGroups.splice(i, 1);
  // Cascade: drop this group's memberships too.
  for (let j = groupChannels.length - 1; j >= 0; j -= 1) {
    if (groupChannels[j].group_id === id) groupChannels.splice(j, 1);
  }
  return delay(undefined);
};

/** Count of channels in a group — for the table's "channels" column. */
export const countGroupChannels = (groupId: string): number =>
  groupChannels.filter((m) => m.group_id === groupId).length;

// --- Group channel membership ---------------------------------------------

export const listGroupChannels = (groupId: string): Promise<RouteGroupChannel[]> =>
  delay(groupChannels.filter((m) => m.group_id === groupId).map((m) => ({ ...m })));

export const addGroupChannel = (
  groupId: string,
  channelId: string,
  priority = 100,
  weight = 100,
): Promise<RouteGroupChannel> => {
  const row: RouteGroupChannel = {
    group_id: groupId,
    channel_id: channelId,
    priority,
    weight,
  };
  groupChannels.push(row);
  return delay({ ...row });
};

export const updateGroupChannel = (
  groupId: string,
  channelId: string,
  patch: Partial<Pick<RouteGroupChannel, 'priority' | 'weight'>>,
): Promise<RouteGroupChannel> => {
  const row = groupChannels.find((m) => m.group_id === groupId && m.channel_id === channelId);
  if (row === undefined) throw new Error(`mock group channel not found: ${groupId}/${channelId}`);
  Object.assign(row, patch);
  return delay({ ...row });
};

export const removeGroupChannel = (groupId: string, channelId: string): Promise<void> => {
  const i = groupChannels.findIndex((m) => m.group_id === groupId && m.channel_id === channelId);
  if (i >= 0) groupChannels.splice(i, 1);
  return delay(undefined);
};
