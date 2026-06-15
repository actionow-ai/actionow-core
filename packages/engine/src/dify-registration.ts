import {
  createDifyBinding,
  createResource,
  type DbOrTx,
  getDifyBinding,
  getResource,
} from '@actionow/db';
import type { CompatReport, PricingModel, ResourceDraft } from '@actionow/dify';
import { buildResourceDraft } from '@actionow/dify';

/**
 * Raised when a workflow cannot be registered for a non-parse reason — first期
 * this is a compat report carrying `block` items (e.g. a knowledge-retrieval
 * node) when the caller did not pass `allowBlockers`. The `blockers` list is the
 * human-readable details so the admin UI / caller can surface them.
 */
export class DifyRegistrationError extends Error {
  readonly code = 'registration_blocked';
  readonly blockers: readonly string[];

  constructor(blockers: readonly string[]) {
    super(`registration_blocked: ${blockers.join('; ')}`);
    this.name = 'DifyRegistrationError';
    this.blockers = blockers;
  }
}

export interface DifyRegistrationServiceDeps {
  db: DbOrTx;
  /** `provider/name` keys for models that already have a mapping. */
  knownModels: ReadonlySet<string>;
}

export interface RegisterInput {
  readonly tenantId: string;
  readonly resourceId: string;
  /** The raw Dify workflow DSL (YAML). */
  readonly yamlText: string;
  /** The BYO Dify app endpoint to call at runtime. */
  readonly endpoint: string;
  /** Locator for the Dify service key secret (uuid of a `secret_ref`), or null. */
  readonly serviceKeyRef: string | null;
  readonly pricingModel: PricingModel;
  /** Persist even when the compat report has `block` items (admin override). */
  readonly allowBlockers?: boolean | undefined;
}

export interface RegisterResult {
  readonly resourceId: string;
  readonly version: number;
  readonly ioSchema: ResourceDraft['ioSchema'];
  readonly compatReport: CompatReport;
}

/**
 * Orchestrates BYO Dify workflow registration (§7.2): parse the DSL into a
 * resource draft (pure `@actionow/dify`), reject blockers (unless overridden),
 * then persist `resource` + `resource_version` + `dify_binding` via the db
 * catalog write repos. No NestJS, no network — apps wrap this plain service.
 *
 * Idempotency / versioning by `dsl_hash`:
 * - first import → version 1.
 * - re-import with the **same** `dsl_hash` → no-op: returns the existing version
 *   without writing a new `resource_version` / binding.
 * - re-import with a **different** `dsl_hash` → bumps `resource.current_version`
 *   and writes a new `resource_version` + binding.
 */
export class DifyRegistrationService {
  private readonly deps: DifyRegistrationServiceDeps;

  constructor(deps: DifyRegistrationServiceDeps) {
    this.deps = deps;
  }

  async register(input: RegisterInput): Promise<RegisterResult> {
    const { db, knownModels } = this.deps;

    // 1. Parse → draft. Throws DifyParseError('metered_not_allowed') for
    //    BYO+metered and other parse failures before any DB write.
    const draft = buildResourceDraft(input.yamlText, {
      resourceId: input.resourceId,
      provisionMode: 'byo',
      pricingModel: input.pricingModel,
      knownModels,
    });

    // 2. Reject blockers (首期: knowledge-dependent workflows) unless overridden.
    if (draft.compatReport.hasBlockers && input.allowBlockers !== true) {
      const blockers = draft.compatReport.items
        .filter((i) => i.severity === 'block')
        .map((i) => i.detail);
      throw new DifyRegistrationError(blockers);
    }

    // 3. dsl_hash no-op detection + version derivation.
    const existingBinding = await getDifyBinding(db, input.resourceId);
    if (existingBinding?.dslHash === draft.dslHash) {
      // Unchanged DSL → no new version. Return the current (already-persisted)
      // version and the freshly-computed schema/report (they are identical).
      return {
        resourceId: input.resourceId,
        version: existingBinding.resourceVersion,
        ioSchema: draft.ioSchema,
        compatReport: draft.compatReport,
      };
    }

    const existingResource = await getResource(db, input.resourceId);
    const version = existingResource ? existingResource.currentVersion + 1 : 1;

    // 4. Persist resource (+ version) and the binding in ONE transaction so a
    //    binding failure rolls the resource/resource_version back together —
    //    otherwise a committed resource is orphaned and a retry trips the
    //    `resource_version_pk` unique on the same version.
    await db.transaction(async (tx) => {
      await createResource(tx, {
        id: input.resourceId,
        tenantId: input.tenantId,
        kind: draft.mode, // 'workflow'
        modality: draft.modality, // 'composite'
        providerType: draft.providerType, // 'dify-workflow'
        execModes: ['blocking'],
        ioSchema: draft.ioSchema,
        version,
      });

      await createDifyBinding(tx, {
        resourceId: input.resourceId,
        resourceVersion: version,
        mode: draft.mode,
        difyAppEndpoint: input.endpoint,
        difyServiceKeyRef: input.serviceKeyRef,
        dslHash: draft.dslHash,
        pricingModel: input.pricingModel,
        provisionMode: draft.provisionMode,
        requiredSecrets: [...draft.requiredSecrets],
        compatReport: draft.compatReport,
      });
    });

    return {
      resourceId: input.resourceId,
      version,
      ioSchema: draft.ioSchema,
      compatReport: draft.compatReport,
    };
  }
}
