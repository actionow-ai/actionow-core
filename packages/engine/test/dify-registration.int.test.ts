import { getResourceWithSchema, schema } from '@actionow/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { DifyRegistrationError } from '../src/dify-registration.js';
import { DifyRegistrationService } from '../src/dify-registration.js';

const { difyBinding, resource, resourceVersion, tenant } = schema;

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: '../db/drizzle' });
}, 120_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

afterEach(async () => {
  await client`TRUNCATE TABLE dify_binding, resource_version, resource, tenant RESTART IDENTITY CASCADE`;
});

const KNOWN_MODELS = new Set(['openai/gpt-4o-mini']);

/** The §7.1 小红书 sample workflow: a model node + a tool node. */
const WORKFLOW_DSL = `
app: { mode: workflow, name: 小红书文案配图, icon: "🎨" }
kind: app
version: "0.1.5"
workflow:
  graph:
    nodes:
      - { id: start, data: { type: start, variables: [
            { variable: topic, label: 主题, type: text-input, required: true, max_length: 100 },
            { variable: tone,  label: 语气, type: select, options: [活泼,专业,种草], default: 活泼 } ] } }
      - { id: llm1, data: { type: llm, model: { provider: openai, name: gpt-4o-mini } } }
      - { id: img1, data: { type: tool, provider_type: builtin, tool_name: dalle3 } }
      - { id: end, data: { type: end, outputs: [
            { variable: caption,   value_selector: [llm1, text] },
            { variable: image_url, value_selector: [img1, image] } ] } }
`;

/** A workflow whose graph references a workspace dataset → blocked首期. */
const KNOWLEDGE_DSL = `
app: { mode: workflow, name: rag, icon: "📚" }
kind: app
version: "0.1.5"
workflow:
  graph:
    nodes:
      - { id: start, data: { type: start, variables: [
            { variable: q, label: question, type: text-input, required: true } ] } }
      - { id: kr1, data: { type: knowledge-retrieval, dataset_ids: [ds-1] } }
      - { id: llm1, data: { type: llm, model: { provider: openai, name: gpt-4o-mini } } }
      - { id: end, data: { type: end, outputs: [
            { variable: answer, value_selector: [llm1, text] } ] } }
`;

async function makeTenant(): Promise<string> {
  const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  return t.id;
}

function buildService(): DifyRegistrationService {
  return new DifyRegistrationService({ db, knownModels: KNOWN_MODELS });
}

function baseInput(tenantId: string, resourceId: string) {
  return {
    tenantId,
    resourceId,
    yamlText: WORKFLOW_DSL,
    endpoint: 'https://dify.example/v1',
    serviceKeyRef: null,
    pricingModel: 'fixed' as const,
  };
}

describe('DifyRegistrationService.register', () => {
  it('persists resource + resource_version + dify_binding for a BYO fixed workflow', async () => {
    const tenantId = await makeTenant();
    const svc = buildService();

    const out = await svc.register(baseInput(tenantId, 'xhs'));

    expect(out.resourceId).toBe('xhs');
    expect(out.version).toBe(1);
    expect(out.ioSchema.inputs.map((i) => i.key)).toEqual(['topic', 'tone']);
    expect(out.ioSchema.outputs.map((o) => o.key)).toEqual(['caption', 'image_url']);
    expect(out.compatReport.hasBlockers).toBe(false);

    // resource row: kind=workflow, provider_type=dify-workflow
    const [resRow] = await db.select().from(resource).where(eq(resource.id, 'xhs'));
    expect(resRow?.kind).toBe('workflow');
    expect(resRow?.providerType).toBe('dify-workflow');
    expect(resRow?.modality).toBe('composite');
    expect(resRow?.currentVersion).toBe(1);

    // resource_version carries the io_schema
    const [verRow] = await db
      .select()
      .from(resourceVersion)
      .where(eq(resourceVersion.resourceId, 'xhs'));
    expect(verRow?.version).toBe(1);

    // dify_binding row: provision_mode=byo, pricing_model=fixed, required secrets
    const [bindRow] = await db.select().from(difyBinding).where(eq(difyBinding.resourceId, 'xhs'));
    expect(bindRow?.provisionMode).toBe('byo');
    expect(bindRow?.pricingModel).toBe('fixed');
    expect(bindRow?.mode).toBe('workflow');
    expect(bindRow?.difyAppEndpoint).toBe('https://dify.example/v1');
    expect(bindRow?.requiredSecrets).toEqual(['dalle3']);

    // getResourceWithSchema returns the io_schema
    const withSchema = await getResourceWithSchema(db, 'xhs');
    expect(withSchema?.ioSchema).toEqual(out.ioSchema);
  });

  it('returns the existing version (no new row) on a no-op re-import with the same dslHash', async () => {
    const tenantId = await makeTenant();
    const svc = buildService();

    const first = await svc.register(baseInput(tenantId, 'noop'));
    const second = await svc.register(baseInput(tenantId, 'noop'));

    expect(second.version).toBe(first.version);
    const versions = await db
      .select()
      .from(resourceVersion)
      .where(eq(resourceVersion.resourceId, 'noop'));
    expect(versions).toHaveLength(1);
    const bindings = await db.select().from(difyBinding).where(eq(difyBinding.resourceId, 'noop'));
    expect(bindings).toHaveLength(1);
  });

  it('bumps to version 2 when re-imported with a different dslHash', async () => {
    const tenantId = await makeTenant();
    const svc = buildService();

    await svc.register(baseInput(tenantId, 'rev'));
    const changed = WORKFLOW_DSL.replace('max_length: 100', 'max_length: 200');
    const second = await svc.register({ ...baseInput(tenantId, 'rev'), yamlText: changed });

    expect(second.version).toBe(2);
    const [resRow] = await db.select().from(resource).where(eq(resource.id, 'rev'));
    expect(resRow?.currentVersion).toBe(2);
    const versions = await db
      .select()
      .from(resourceVersion)
      .where(eq(resourceVersion.resourceId, 'rev'));
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
    const bindings = await db.select().from(difyBinding).where(eq(difyBinding.resourceId, 'rev'));
    expect(bindings.map((b) => b.resourceVersion).sort()).toEqual([1, 2]);
  });

  it('rejects BYO + metered with metered_not_allowed and writes nothing', async () => {
    const tenantId = await makeTenant();
    const svc = buildService();

    await expect(
      svc.register({ ...baseInput(tenantId, 'metered'), pricingModel: 'metered' }),
    ).rejects.toThrow(/metered_not_allowed/);

    const resources = await db.select().from(resource);
    expect(resources).toHaveLength(0);
  });

  it('blocks a knowledge-dependent workflow and writes nothing', async () => {
    const tenantId = await makeTenant();
    const svc = buildService();

    await expect(
      svc.register({ ...baseInput(tenantId, 'rag'), yamlText: KNOWLEDGE_DSL }),
    ).rejects.toBeInstanceOf(DifyRegistrationError);

    const resources = await db.select().from(resource);
    expect(resources).toHaveLength(0);
  });

  it('allows a blocked workflow through when allowBlockers is set', async () => {
    const tenantId = await makeTenant();
    const svc = buildService();

    const out = await svc.register({
      ...baseInput(tenantId, 'rag-forced'),
      yamlText: KNOWLEDGE_DSL,
      allowBlockers: true,
    });

    expect(out.compatReport.hasBlockers).toBe(true);
    const [resRow] = await db.select().from(resource).where(eq(resource.id, 'rag-forced'));
    expect(resRow?.id).toBe('rag-forced');
  });
});
