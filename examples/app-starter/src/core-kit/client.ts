import { createActionowClient } from '@actionow/sdk';

export type Client = ReturnType<typeof createActionowClient>;

/** Control-plane client (tenant-admin USER JWT) — server-side ONLY. */
export function consoleClient(baseUrl: string, jwt: string): Client {
  return createActionowClient({ baseUrl, token: jwt });
}

/** Data-plane client (ak_). */
export function dataClient(baseUrl: string, ak: string): Client {
  return createActionowClient({ baseUrl, token: ak });
}

/**
 * Raw fetch for endpoints OUTSIDE the generated OpenAPI (so @actionow/sdk can't
 * type them): the whole relay dialect (/v1/chat/completions, /v1/embeddings, …),
 * /auth/login, and /console/{subjects,redeem,limit-plans}*. Throws on non-2xx
 * with the unified error attached as `.error`.
 */
export async function rawPost<T = unknown>(baseUrl: string, path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw Object.assign(new Error(`${path} → HTTP ${res.status}`), { status: res.status, error: json.error });
  return json as T;
}

export async function rawGet<T = unknown>(baseUrl: string, path: string, token?: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw Object.assign(new Error(`${path} → HTTP ${res.status}`), { status: res.status, error: json.error });
  return json as T;
}
