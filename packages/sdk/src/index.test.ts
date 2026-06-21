import { describe, expect, it, vi } from 'vitest';

import { createActionowClient } from './index.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('@actionow/sdk typed client', () => {
  it('GET /admin/models returns the typed page envelope and sends the bearer token', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        jsonResponse({
          data: [
            {
              id: 'm1',
              name: 'gpt-4o',
              display: null,
              modality: 'text',
              capabilities: { tools: true },
              visibility: 'public',
              resource_id: 'r1',
              input_price: '5000000',
              output_price: '15000000',
              status: 'active',
              created_at: '2026-01-01T00:00:00Z',
            },
          ],
          next_cursor: null,
          has_more: false,
        }),
      ),
    );

    const client = createActionowClient({
      baseUrl: 'https://api.test',
      token: 'admintok',
      fetch: fetchMock,
    });

    const { data } = await client.GET('/admin/models');

    // Typed straight from the contract: data.data is ModelView[]; prices are
    // µcredit STRINGS (the invariant carried all the way from the zod schema).
    expect(data?.data[0]?.name).toBe('gpt-4o');
    expect(data?.data[0]?.input_price).toBe('5000000');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const req = fetchMock.mock.calls[0]?.[0] as Request;
    expect(req.headers.get('authorization')).toBe('Bearer admintok');
  });
});
