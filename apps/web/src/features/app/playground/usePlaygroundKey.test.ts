import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createApiKey = vi.fn();
const rotateApiKey = vi.fn();

vi.mock('../../../lib/api/useConsoleApi', () => ({
  useConsoleApi: () => ({ createApiKey, rotateApiKey }),
}));

import { usePlaygroundKey } from './usePlaygroundKey';

const STORAGE_KEY = 'actionow.playground_key';

beforeEach(() => {
  localStorage.clear();
  createApiKey.mockReset();
  rotateApiKey.mockReset();
});
afterEach(() => {
  localStorage.clear();
});

describe('usePlaygroundKey', () => {
  it('reuses a cached key without minting', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: 'k1', plaintext: 'ak_cached' }));
    const { result } = renderHook(() => usePlaygroundKey());
    expect(result.current.ready).toBe(true);
    expect(result.current.key).toBe('ak_cached');
    expect(createApiKey).not.toHaveBeenCalled();
  });

  it('mints + caches a key on first use (empty cache)', async () => {
    createApiKey.mockResolvedValue({ id: 'k2', plaintext: 'ak_fresh' });
    const { result } = renderHook(() => usePlaygroundKey());
    expect(result.current.ready).toBe(false);

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.key).toBe('ak_fresh');
    expect(createApiKey).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({
      id: 'k2',
      plaintext: 'ak_fresh',
    });
  });

  it('recover() rotates the cached key for a fresh plaintext', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: 'k3', plaintext: 'ak_old' }));
    rotateApiKey.mockResolvedValue({ id: 'k3', plaintext: 'ak_rotated' });
    const { result } = renderHook(() => usePlaygroundKey());

    const fresh = await result.current.recover();
    expect(fresh).toBe('ak_rotated');
    expect(rotateApiKey).toHaveBeenCalledWith('k3');
    await waitFor(() => expect(result.current.key).toBe('ak_rotated'));
  });
});
