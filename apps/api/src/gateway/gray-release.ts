// apps/api/src/gateway/gray-release.ts
//
// model-supply-greenfield 批次4 slice6 — 切换预案② the per-tenant GRAY-RELEASE
// HOOK for the legacy→new-gateway cutover. Semantics (plan v3):
//
//   预案① — the NEW task-paradigm endpoints (/v1/videos/generations,
//   /v1/audio/music, /v1/tasks 族, /v1/gateway/models) are FULLY LIVE for
//   every tenant; this flag does NOT gate them.
//
//   预案② — during the migration window, the LEGACY sync surfaces
//   (chat/embeddings/…) will branch per tenant: route through the NEW supply
//   gateway (this flag true) or keep the old relay path (false). THIS module
//   only delivers the hook — the actual chat/embeddings branch lands with the
//   migration window (批次5 时序, plan v3 切换四步之③).
//
// Resolution order (the account.config/SettingsResolver 范式 scout 已确认):
//   1. tenant.config.gateway_v2 — the per-tenant EXPLICIT boolean
//      (@actionow/db getTenantGatewayV2Flag; set via the admin tenant-config
//      surface, no deploy needed);
//   2. platform default — dynamic-config key GATEWAY_V2_DEFAULT
//      (SettingsResolver: DB override → env GATEWAY_V2_DEFAULT → false).
import type { Database } from '@actionow/db';
import { getTenantGatewayV2Flag } from '@actionow/db';

/** The pure resolution rule: explicit tenant opinion wins; else the platform default. */
export function resolveGatewayV2Enabled(
  tenantFlag: boolean | undefined,
  platformDefault: boolean,
): boolean {
  return tenantFlag ?? platformDefault;
}

/** The read seam (injectable in tests; production = the db repo + SettingsService). */
export interface GatewayGrayReleaseDeps {
  db: Database;
  /** SettingsService#get (or any resolver) for the GATEWAY_V2_DEFAULT key. */
  getPlatformDefault: () => Promise<boolean>;
  /** Injectable tenant-config read; default = the real repo. */
  getTenantFlag?: typeof getTenantGatewayV2Flag | undefined;
}

/**
 * Should THIS tenant's legacy sync traffic ride the NEW gateway? The one
 * question the migration-window branch (批次5) asks. Fail-closed on absence:
 * no tenant opinion + no override ⇒ the env default (false) — a tenant is
 * never migrated by accident.
 */
export async function isGatewayV2Tenant(
  deps: GatewayGrayReleaseDeps,
  tenantId: string,
): Promise<boolean> {
  const read = deps.getTenantFlag ?? getTenantGatewayV2Flag;
  const [tenantFlag, platformDefault] = await Promise.all([
    read(deps.db, tenantId),
    deps.getPlatformDefault(),
  ]);
  return resolveGatewayV2Enabled(tenantFlag, platformDefault);
}
