import type { Database } from '@actionow/db';

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
