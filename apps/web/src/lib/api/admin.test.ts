import { describe, expect, it, vi } from 'vitest';

import { makeAdminApi } from './admin';
import type { ApiClient } from './client';

function fakeClient() {
  const calls: {
    method: 'get' | 'getPage' | 'post' | 'patch' | 'delete';
    path: string;
    arg: unknown;
  }[] = [];
  const client = {
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
    delete: vi.fn((path: string) => {
      calls.push({ method: 'delete', path, arg: undefined });
      return Promise.resolve(undefined);
    }),
  } as unknown as ApiClient;
  return { client, calls };
}

describe('admin catalog api', () => {
  it('createResource posts to /admin/resources', async () => {
    const { client, calls } = fakeClient();
    await makeAdminApi(client).createResource({
      id: 'r1',
      tenantId: 't1',
      kind: 'model',
      modality: 'text',
      providerType: 'openai',
      execModes: ['blocking'],
      ioSchema: {},
    });
    expect(calls[0]).toEqual({
      method: 'post',
      path: '/admin/resources',
      arg: expect.objectContaining({ id: 'r1' }),
    });
  });

  it('createChannel posts to the resource-scoped channels path', async () => {
    const { client, calls } = fakeClient();
    await makeAdminApi(client).createChannel('r1', { providerType: 'openai', weight: 1 });
    expect(calls[0]?.path).toBe('/admin/resources/r1/channels');
  });

  it('listPricebook paginates /admin/pricebook with resourceId', async () => {
    const { client, calls } = fakeClient();
    await makeAdminApi(client).listPricebook('r1');
    expect(calls[0]).toEqual({
      method: 'getPage',
      path: '/admin/pricebook',
      arg: { resourceId: 'r1' },
    });
  });

  it('catalog lists return arrays (envelope rows unwrapped)', async () => {
    const { client } = fakeClient();
    const api = makeAdminApi(client);
    await expect(api.listTenants()).resolves.toEqual([]);
    await expect(api.listResources()).resolves.toEqual([]);
    await expect(api.listChannels('r1')).resolves.toEqual([]);
    await expect(api.listModels()).resolves.toEqual([]);
    await expect(api.listApiKeys('t1')).resolves.toEqual([]);
  });

  it('listJobs returns a Page (paginates /admin/jobs)', async () => {
    const { client, calls } = fakeClient();
    const page = await makeAdminApi(client).listJobs({ tenantId: 't1', limit: 8 });
    expect(page).toEqual({ rows: [], nextCursor: null });
    expect(calls[0]).toEqual({
      method: 'getPage',
      path: '/admin/jobs',
      arg: { tenantId: 't1', cursor: undefined, limit: 8 },
    });
  });

  it('deleteChannel deletes the resource-scoped channel path', async () => {
    const { client, calls } = fakeClient();
    await makeAdminApi(client).deleteChannel('r1', 'c1');
    expect(calls[0]).toEqual({
      method: 'delete',
      path: '/admin/resources/r1/channels/c1',
      arg: undefined,
    });
  });

  it('syncChannelModels posts to the channel sync-models path', async () => {
    const { client, calls } = fakeClient();
    await makeAdminApi(client).syncChannelModels('r1', 'c1', {});
    expect(calls[0]?.method).toBe('post');
    expect(calls[0]?.path).toBe('/admin/resources/r1/channels/c1/sync-models');
  });

  it('updateResource patches /admin/resources/:id', async () => {
    const { client, calls } = fakeClient();
    await makeAdminApi(client).updateResource('r1', { status: 'disabled' });
    expect(calls[0]).toEqual({
      method: 'patch',
      path: '/admin/resources/r1',
      arg: { status: 'disabled' },
    });
  });

  it('listModifiers paginates /admin/modifiers', async () => {
    const { client, calls } = fakeClient();
    await makeAdminApi(client).listModifiers();
    expect(calls[0]?.method).toBe('getPage');
    expect(calls[0]?.path).toBe('/admin/modifiers');
  });

  it('difyImport posts to /admin/dify/import', async () => {
    const { client, calls } = fakeClient();
    await makeAdminApi(client).difyImport({
      tenantId: 't1',
      resourceId: 'r1',
      yaml: 'x',
      endpoint: 'https://e',
      pricingModel: 'fixed',
    });
    expect(calls[0]?.path).toBe('/admin/dify/import');
  });
});
