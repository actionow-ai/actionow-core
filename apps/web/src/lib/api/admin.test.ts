import { describe, expect, it, vi } from 'vitest';

import { makeAdminApi } from './admin';
import type { ApiClient } from './client';
import type { SdkClient } from './sdkClient';

/** One recorded call against either transport, normalized to a concrete path. */
interface Call {
  method: string;
  path: string;
  arg: unknown;
}

/** Substitute `{name}` path params into the template to get the concrete path. */
function concretePath(
  template: string,
  opts?: { params?: { path?: Record<string, string> } },
): string {
  const path = opts?.params?.path ?? {};
  return template.replace(/\{(\w+)}/g, (_m, k: string) => path[k] ?? `{${k}}`);
}

/** An openapi-fetch-shaped success result (`{ data, error, response }`). */
function ok(data: unknown): { data: unknown; error: undefined; response: Response } {
  return { data, error: undefined, response: new Response(null, { status: 200 }) };
}

/**
 * A fake SDK (records GET/POST/PATCH/PUT/DELETE) PLUS a fake raw client (records
 * the lowercase verbs the hybrid methods still use). Both push into one `calls`
 * array so a test can assert against whichever transport a method uses.
 */
function fakeApis() {
  const calls: Call[] = [];

  const recordSdk =
    (method: string) =>
    (template: string, opts?: { body?: unknown; params?: { query?: unknown } }) => {
      const concrete = concretePath(template, opts as never);
      const arg = opts?.body ?? opts?.params?.query;
      calls.push({ method, path: concrete, arg });
      // List routes return the page envelope; everything else an empty object.
      const isList = method === 'GET';
      return Promise.resolve(ok(isList ? { data: [], next_cursor: null, has_more: false } : {}));
    };

  const sdk = {
    GET: vi.fn(recordSdk('GET')),
    POST: vi.fn(recordSdk('POST')),
    PATCH: vi.fn(recordSdk('PATCH')),
    PUT: vi.fn(recordSdk('PUT')),
    DELETE: vi.fn(recordSdk('DELETE')),
  } as unknown as SdkClient;

  const rawClient = {
    get: vi.fn((path: string, query?: unknown) => {
      calls.push({ method: 'get', path, arg: query });
      return Promise.resolve([]);
    }),
    getPage: vi.fn((path: string, query?: unknown) => {
      calls.push({ method: 'getPage', path, arg: query });
      return Promise.resolve({ rows: [], nextCursor: null });
    }),
    post: vi.fn((path: string, body?: unknown, opts?: unknown) => {
      calls.push({ method: 'post', path, arg: body ?? opts });
      return Promise.resolve({});
    }),
    patch: vi.fn((path: string, body?: unknown) => {
      calls.push({ method: 'patch', path, arg: body });
      return Promise.resolve({});
    }),
    put: vi.fn((path: string, body?: unknown) => {
      calls.push({ method: 'put', path, arg: body });
      return Promise.resolve({});
    }),
    delete: vi.fn((path: string) => {
      calls.push({ method: 'delete', path, arg: undefined });
      return Promise.resolve(undefined);
    }),
  } as unknown as ApiClient;

  const api = makeAdminApi(sdk, rawClient, () => undefined);
  return { api, calls };
}

describe('admin catalog api', () => {
  it('createResource posts to /admin/resources', async () => {
    const { api, calls } = fakeApis();
    await api.createResource({
      id: 'r1',
      tenantId: 't1',
      kind: 'model',
      modality: 'text',
      providerType: 'openai',
      execModes: ['blocking'],
      ioSchema: {},
    });
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/admin/resources',
      arg: expect.objectContaining({ id: 'r1' }),
    });
  });

  it('createChannel posts to the resource-scoped channels path', async () => {
    const { api, calls } = fakeApis();
    await api.createChannel('r1', { providerType: 'openai', weight: 1 });
    expect(calls[0]?.path).toBe('/admin/resources/r1/channels');
  });

  it('listPricebook paginates /admin/pricebook with resourceId', async () => {
    const { api, calls } = fakeApis();
    await api.listPricebook('r1');
    expect(calls[0]).toEqual({
      method: 'GET',
      path: '/admin/pricebook',
      arg: { resourceId: 'r1' },
    });
  });

  it('catalog lists return arrays (envelope rows unwrapped)', async () => {
    const { api } = fakeApis();
    await expect(api.listTenants()).resolves.toEqual([]);
    await expect(api.listResources()).resolves.toEqual([]);
    await expect(api.listChannels('r1')).resolves.toEqual([]);
    await expect(api.listModels()).resolves.toEqual([]);
    await expect(api.listApiKeys('t1')).resolves.toEqual([]);
  });

  it('listJobs returns a Page (paginates /admin/jobs)', async () => {
    const { api, calls } = fakeApis();
    const page = await api.listJobs({ tenantId: 't1', limit: 8 });
    expect(page).toEqual({ rows: [], nextCursor: null });
    expect(calls[0]).toEqual({
      method: 'GET',
      path: '/admin/jobs',
      arg: { tenantId: 't1', cursor: undefined, limit: 8 },
    });
  });

  it('deleteChannel deletes the resource-scoped channel path', async () => {
    const { api, calls } = fakeApis();
    await api.deleteChannel('r1', 'c1');
    expect(calls[0]).toEqual({
      method: 'DELETE',
      path: '/admin/resources/r1/channels/c1',
      arg: undefined,
    });
  });

  it('syncChannelModels posts to the channel sync-models path (raw client)', async () => {
    const { api, calls } = fakeApis();
    await api.syncChannelModels('r1', 'c1', {});
    expect(calls[0]?.method).toBe('post');
    expect(calls[0]?.path).toBe('/admin/resources/r1/channels/c1/sync-models');
  });

  it('updateResource patches /admin/resources/:id', async () => {
    const { api, calls } = fakeApis();
    await api.updateResource('r1', { status: 'disabled' });
    expect(calls[0]).toEqual({
      method: 'PATCH',
      path: '/admin/resources/r1',
      arg: { status: 'disabled' },
    });
  });

  it('listModifiers paginates /admin/modifiers', async () => {
    const { api, calls } = fakeApis();
    await api.listModifiers();
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.path).toBe('/admin/modifiers');
  });
});

// P0 coverage-gap fixes: write paths the backend already serves but the FE
// never exposed (provision; pricebook/modifier edit+delete; tenant update).
describe('admin CRUD-completion (P0 gaps)', () => {
  it('provision posts to /admin/provision (atomic tenant+account+key)', async () => {
    const { api, calls } = fakeApis();
    await api.provision({ name: 'Acme', credits: 100 });
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/admin/provision',
      arg: expect.objectContaining({ name: 'Acme', credits: 100 }),
    });
  });

  it('updateTenant patches /admin/tenants/:id', async () => {
    const { api, calls } = fakeApis();
    await api.updateTenant('t1', { isolationMode: 'schema' });
    expect(calls[0]).toEqual({
      method: 'PATCH',
      path: '/admin/tenants/t1',
      arg: { isolationMode: 'schema' },
    });
  });

  it('updatePricebook patches /admin/pricebook/:id', async () => {
    const { api, calls } = fakeApis();
    await api.updatePricebook('pb1', { active: false });
    expect(calls[0]).toEqual({
      method: 'PATCH',
      path: '/admin/pricebook/pb1',
      arg: { active: false },
    });
  });

  it('deletePricebook deletes /admin/pricebook/:id', async () => {
    const { api, calls } = fakeApis();
    await api.deletePricebook('pb1');
    expect(calls[0]).toEqual({ method: 'DELETE', path: '/admin/pricebook/pb1', arg: undefined });
  });

  it('updateModifier patches /admin/modifiers/:id', async () => {
    const { api, calls } = fakeApis();
    await api.updateModifier('m1', { active: false });
    expect(calls[0]).toEqual({
      method: 'PATCH',
      path: '/admin/modifiers/m1',
      arg: { active: false },
    });
  });

  it('deleteModifier deletes /admin/modifiers/:id', async () => {
    const { api, calls } = fakeApis();
    await api.deleteModifier('m1');
    expect(calls[0]).toEqual({ method: 'DELETE', path: '/admin/modifiers/m1', arg: undefined });
  });

  it('listAdminTokens paginates /admin/tokens (rows)', async () => {
    const { api, calls } = fakeApis();
    await expect(api.listAdminTokens()).resolves.toEqual([]);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.path).toBe('/admin/tokens');
  });

  it('createAdminToken posts to /admin/tokens (plaintext once)', async () => {
    const { api, calls } = fakeApis();
    await api.createAdminToken({ name: 'ci-bot' });
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/admin/tokens',
      arg: expect.objectContaining({ name: 'ci-bot' }),
    });
  });

  it('revokeAdminToken deletes /admin/tokens/:id', async () => {
    const { api, calls } = fakeApis();
    await api.revokeAdminToken('tok1');
    expect(calls[0]).toEqual({ method: 'DELETE', path: '/admin/tokens/tok1', arg: undefined });
  });

  it('deleteSecret deletes /admin/secrets/:id', async () => {
    const { api, calls } = fakeApis();
    await api.deleteSecret('s1');
    expect(calls[0]).toEqual({ method: 'DELETE', path: '/admin/secrets/s1', arg: undefined });
  });
});

// P1: list endpoints return the keyset Page envelope + forward cursor/limit so
// the pages can Load-more (was: first page only, nextCursor dropped).
describe('admin keyset pagination (P1)', () => {
  it('listModifiers returns a Page and forwards the cursor', async () => {
    const { api, calls } = fakeApis();
    await expect(api.listModifiers({ cursor: 'c1', limit: 50 })).resolves.toEqual({
      rows: [],
      nextCursor: null,
    });
    expect(calls[0]).toEqual({
      method: 'GET',
      path: '/admin/modifiers',
      arg: { cursor: 'c1', limit: 50 },
    });
  });

  it('listRedemptionCodes forwards status + cursor in one query', async () => {
    const { api, calls } = fakeApis();
    await api.listRedemptionCodes({ status: 'unused', cursor: 'c2', limit: 50 });
    expect(calls[0]).toEqual({
      method: 'GET',
      path: '/admin/redemption-codes',
      arg: { status: 'unused', cursor: 'c2', limit: 50 },
    });
  });

  it('listOAuthSessions returns a Page and forwards the cursor', async () => {
    const { api, calls } = fakeApis();
    await expect(api.listOAuthSessions({ cursor: 'c3', limit: 50 })).resolves.toEqual({
      rows: [],
      nextCursor: null,
    });
    expect(calls[0]?.path).toBe('/admin/oauth-sessions');
    expect(calls[0]?.arg).toEqual({ cursor: 'c3', limit: 50 });
  });
});

describe('admin route-groups api', () => {
  it('addGroupChannel issues a PUT membership upsert (not POST), no idempotency key', async () => {
    const { api, calls } = fakeApis();
    await api.addGroupChannel('g1', 'c1', { priority: 2, weight: 3 });
    expect(calls[0]).toEqual({
      method: 'PUT',
      path: '/admin/route-groups/g1/channels/c1',
      arg: { priority: 2, weight: 3 },
    });
  });

  it('listRouteGroups paginates /admin/route-groups (rows unwrapped)', async () => {
    const { api, calls } = fakeApis();
    await expect(api.listRouteGroups()).resolves.toEqual([]);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.path).toBe('/admin/route-groups');
  });

  it('listGroupChannels paginates the group-scoped channels path', async () => {
    const { api, calls } = fakeApis();
    await api.listGroupChannels('g1');
    expect(calls[0]?.path).toBe('/admin/route-groups/g1/channels');
  });

  it('createRouteGroup posts to /admin/route-groups; updateRouteGroup patches :id', async () => {
    const { api, calls } = fakeApis();
    await api.createRouteGroup({ name: 'g', groupRatioBps: 12000 }, 'idem-1');
    await api.updateRouteGroup('g1', { groupRatioBps: 15000 });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe('/admin/route-groups');
    expect(calls[1]).toEqual({
      method: 'PATCH',
      path: '/admin/route-groups/g1',
      arg: { groupRatioBps: 15000 },
    });
  });

  it('deleteRouteGroup + removeGroupChannel delete their paths', async () => {
    const { api, calls } = fakeApis();
    await api.deleteRouteGroup('g1');
    await api.removeGroupChannel('g1', 'c1');
    expect(calls[0]).toEqual({ method: 'DELETE', path: '/admin/route-groups/g1', arg: undefined });
    expect(calls[1]).toEqual({
      method: 'DELETE',
      path: '/admin/route-groups/g1/channels/c1',
      arg: undefined,
    });
  });
});

describe('admin official-prices api', () => {
  it('listOfficialPrices paginates /admin/official-prices (keyset Page)', async () => {
    const { api, calls } = fakeApis();
    await expect(api.listOfficialPrices({ cursor: 'c1', limit: 50 })).resolves.toEqual({
      rows: [],
      nextCursor: null,
    });
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.path).toBe('/admin/official-prices');
    expect(calls[0]?.arg).toEqual({ cursor: 'c1', limit: 50 });
  });

  it('createOfficialPrice posts a camelCase HUMAN-USD body (no client µUSD pre-multiply)', async () => {
    const { api, calls } = fakeApis();
    await api.createOfficialPrice(
      { provider: 'openai', modelSlug: 'gpt-4o', inputUsdPer1m: 2.5, outputUsdPer1m: 10 },
      'idem-1',
    );
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe('/admin/official-prices');
    expect(calls[0]?.arg).toEqual(
      expect.objectContaining({ inputUsdPer1m: 2.5, outputUsdPer1m: 10 }),
    );
  });

  it('updateOfficialPrice patches :id; deleteOfficialPrice deletes :id', async () => {
    const { api, calls } = fakeApis();
    await api.updateOfficialPrice('p1', { inputUsdPer1m: 3 });
    await api.deleteOfficialPrice('p1');
    expect(calls[0]).toEqual({
      method: 'PATCH',
      path: '/admin/official-prices/p1',
      arg: { inputUsdPer1m: 3 },
    });
    expect(calls[1]).toEqual({
      method: 'DELETE',
      path: '/admin/official-prices/p1',
      arg: undefined,
    });
  });
});

describe('admin api-keys group-bind + revoke api', () => {
  it('updateApiKeyGroup PATCHes the :id/group path; null unbinds (raw client)', async () => {
    const { api, calls } = fakeApis();
    await api.updateApiKeyGroup('k1', { routeGroupId: 'g1' });
    await api.updateApiKeyGroup('k1', { routeGroupId: null });
    expect(calls[0]).toEqual({
      method: 'patch',
      path: '/admin/api-keys/k1/group',
      arg: { routeGroupId: 'g1' },
    });
    expect(calls[1]).toEqual({
      method: 'patch',
      path: '/admin/api-keys/k1/group',
      arg: { routeGroupId: null },
    });
  });

  it('deleteApiKey revokes via DELETE /admin/api-keys/:id', async () => {
    const { api, calls } = fakeApis();
    await api.deleteApiKey('k1');
    expect(calls[0]).toEqual({ method: 'DELETE', path: '/admin/api-keys/k1', arg: undefined });
  });
});

describe('admin relay-traces api', () => {
  it('listRelayTraces paginates /admin/relay-traces with the cursor + filters (typed SDK)', async () => {
    const { api, calls } = fakeApis();
    await api.listRelayTraces({
      tenantId: 't1',
      providerType: 'openai',
      limit: 50,
      cursor: 'c1',
    });
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.path).toBe('/admin/relay-traces');
    expect(calls[0]?.arg).toMatchObject({
      tenantId: 't1',
      providerType: 'openai',
      limit: 50,
      cursor: 'c1',
    });
  });

  it('forwards the route_tag (染色) filter to the query', async () => {
    const { api, calls } = fakeApis();
    await api.listRelayTraces({ routeTag: 'canary', limit: 50 });
    expect(calls[0]?.path).toBe('/admin/relay-traces');
    expect(calls[0]?.arg).toMatchObject({ routeTag: 'canary' });
  });
});
