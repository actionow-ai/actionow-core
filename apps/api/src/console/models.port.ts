import type { Database } from '@actionow/db';
import { listVisibleModels } from '@actionow/db';

/**
 * The tenant-scoped public view of a catalog model the console lists. Owned by
 * Track C (the catalog), reproduced here as the shape the console depends on so
 * Track B stays independent of Track C's internals.
 */
export interface ModelView {
  readonly name: string;
  readonly display: string;
  readonly modality: string;
  readonly capabilities: unknown;
  readonly visibility: string;
  /** Catalog facets (catalog-tags-ia). */
  readonly tags: string[];
  readonly maker: string | null;
  readonly contextLength: number | null;
  readonly reasoning: string | null;
}

/**
 * The seam the ConsoleService reads the visible-models list through. Track C
 * implements `listVisibleModels` (tenant-scoped); Track B injects a fake so it
 * can ship and be tested without depending on Track C.
 */
export interface ModelsPort {
  listVisibleModels(db: Database, tenantId: string): Promise<ModelView[]>;
}

/** DI token for the {@link ModelsPort} provider. */
export const MODELS_PORT = Symbol('MODELS_PORT');

/**
 * The default {@link ModelsPort}: returns no models. Lets the console module
 * boot and the service be exercised before Track C wires the real catalog port.
 */
export const fakeModelsPort: ModelsPort = {
  listVisibleModels: () => Promise.resolve([]),
};

/**
 * The real {@link ModelsPort} (Track C): delegates to the `@actionow/db`
 * `listVisibleModels` repo (public + tenant-granted models, visibility-gated in
 * SQL) and maps each repo row to the console {@link ModelView}. The repo's
 * `display` is nullable; it is coerced to a non-null string via `display ?? name`
 * so the console contract's `display: string` always holds.
 */
export const realModelsPort: ModelsPort = {
  async listVisibleModels(db: Database, tenantId: string): Promise<ModelView[]> {
    const rows = await listVisibleModels(db, tenantId);
    return rows.map((m) => ({
      name: m.name,
      display: m.display ?? m.name,
      modality: m.modality,
      capabilities: m.capabilities,
      visibility: m.visibility,
      tags: m.tags,
      maker: m.maker,
      contextLength: m.contextLength,
      reasoning: m.reasoning,
    }));
  },
};
