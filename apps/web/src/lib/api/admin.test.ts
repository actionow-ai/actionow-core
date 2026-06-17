import { describe, expect, it, vi } from 'vitest';

import { makeAdminApi } from './admin';
import type { ApiClient } from './client';

function fakeClient() {
  const calls: { method: 'get' | 'post'; path: string; arg: unknown }[] = [];
  const client = {
    get: vi.fn((path: string, query?: unknown) => {
      calls.push({ method: 'get', path, arg: query });
      return Promise.resolve([]);
    }),
    post: vi.fn((path: string, body?: unknown) => {
      calls.push({ method: 'post', path, arg: body });
      return Promise.resolve({});
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

  it('listPricebook gets /admin/pricebook with resourceId', async () => {
    const { client, calls } = fakeClient();
    await makeAdminApi(client).listPricebook('r1');
    expect(calls[0]).toEqual({
      method: 'get',
      path: '/admin/pricebook',
      arg: { resourceId: 'r1' },
    });
  });

  it('listModifiers gets /admin/modifiers', async () => {
    const { client, calls } = fakeClient();
    await makeAdminApi(client).listModifiers();
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
