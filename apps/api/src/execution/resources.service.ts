import type { Database, PricebookEntryRow, Resource } from '@actionow/db';
import {
  getActivePricebookEntry,
  getResourceWithSchema,
  listResourcesByTenant,
} from '@actionow/db';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantContext } from '../auth/auth.service.js';
import { engineNotFound } from '../common/errors.js';
import { DB } from '../common/tokens.js';

/** A pricing summary surfaced on the single-resource view (§4.5). */
export interface PricingSummary {
  /** `unit` | `matrix` | `fixed` | `formula` | `passthrough`. */
  method: string;
  /** `pre` | `post`. */
  timing: string;
  /** The active pricebook spec (µcredit amounts already serialized as strings). */
  spec: unknown;
}

/**
 * A catalog entry as returned by `GET /v1/resources` (§4.5, list view). Keys are
 * snake_case to match the rest of the public API surface.
 */
export interface ResourceSummary {
  id: string;
  kind: string;
  modality: string;
  provider_type: string;
  exec_modes: string[];
}

/** A single resource as returned by `GET /v1/resources/:id` (§4.5). */
export interface ResourceDetail extends ResourceSummary {
  io_schema: unknown;
  pricing?: PricingSummary;
}

/**
 * Read side of the public resource-discovery surface (§4.5). Every read is
 * scoped to the caller's tenant: the list is filtered by `tenantId` in the db,
 * and a single fetch 404s when the resource belongs to another tenant — so a key
 * can never enumerate or inspect a resource it does not own. The API key's
 * `resourceAllowlist` further narrows what is visible.
 */
@Injectable()
export class ResourcesService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * List the caller's resources. `allowlist` (the API key's `resourceAllowlist`)
   * further restricts the result; an empty allowlist means "no restriction".
   */
  async list(ctx: TenantContext, allowlist: readonly string[]): Promise<ResourceSummary[]> {
    const rows = await listResourcesByTenant(this.db, ctx.tenantId);
    const visible = allowlist.length === 0 ? rows : rows.filter((r) => allowlist.includes(r.id));
    return visible.map(toSummary);
  }

  /**
   * Fetch one resource (with its io_schema + a pricing summary). 404s when the
   * resource is missing, owned by another tenant, or excluded by the key's
   * `resourceAllowlist`.
   */
  async get(
    resourceId: string,
    ctx: TenantContext,
    allowlist: readonly string[],
  ): Promise<ResourceDetail> {
    if (allowlist.length > 0 && !allowlist.includes(resourceId)) {
      throw engineNotFound(`resource ${resourceId} not found`);
    }
    const row = await getResourceWithSchema(this.db, resourceId);
    if (row?.tenantId !== ctx.tenantId) {
      throw engineNotFound(`resource ${resourceId} not found`);
    }
    const pricebook = await getActivePricebookEntry(this.db, resourceId, row.currentVersion);
    const detail: ResourceDetail = { ...toSummary(row), io_schema: row.ioSchema };
    if (pricebook !== undefined) {
      return { ...detail, pricing: toPricingSummary(pricebook) };
    }
    return detail;
  }
}

/** Project a resource row to the §4.5 snake_case list view (no io_schema). */
function toSummary(row: Resource): ResourceSummary {
  return {
    id: row.id,
    kind: row.kind,
    modality: row.modality,
    provider_type: row.providerType,
    exec_modes: row.execModes,
  };
}

/** Project the active pricebook row to the §4.5 pricing summary. */
function toPricingSummary(row: PricebookEntryRow): PricingSummary {
  return { method: row.method, timing: row.timing, spec: row.spec };
}
