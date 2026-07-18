import { useCallback, useRef, useState } from 'react';

import { apiFetch } from '@/api/client';

/**
 * Playground API-key acquisition. Two postures:
 * - tenant admin: auto-mint a dedicated key via `POST /console/api-keys`, cache
 *   `{id, plaintext}` in localStorage, rotate to self-heal on a data-plane 401;
 * - member seat (mint is admin-only → 403): paste an `ak_` key, kept in
 *   component state only — persisted to the same slot ONLY when the user opts in.
 *
 * The plaintext is never logged and only rendered by the page's one-time
 * mint-result dialog.
 */

const STORAGE_KEY = 'actionow.playground.key';
/** Slot `id` marker for an opt-in persisted pasted key (no server-side id known). */
const PASTED_ID = 'pasted';

export interface PlaygroundKey {
  id: string;
  plaintext: string;
}

function readSlot(): PlaygroundKey | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<PlaygroundKey>;
    if (typeof parsed.id !== 'string' || typeof parsed.plaintext !== 'string') return null;
    return { id: parsed.id, plaintext: parsed.plaintext };
  } catch {
    return null;
  }
}

function writeSlot(key: PlaygroundKey | null): void {
  try {
    if (key === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(key));
  } catch {
    // Key still applies in-memory for this session.
  }
}

export function usePlaygroundKey() {
  const [cachedKey, setCachedKeyState] = useState<PlaygroundKey | null>(() => {
    const slot = readSlot();
    return slot !== null && slot.id !== PASTED_ID ? slot : null;
  });
  const [pastedKey, setPastedKeyState] = useState<string>(() => {
    const slot = readSlot();
    return slot !== null && slot.id === PASTED_ID ? slot.plaintext : '';
  });
  const [rememberPasted, setRememberPastedState] = useState<boolean>(
    () => readSlot()?.id === PASTED_ID,
  );

  const cachedRef = useRef(cachedKey);
  const pastedRef = useRef(pastedKey);
  const rememberRef = useRef(rememberPasted);

  const setCachedKey = useCallback((key: PlaygroundKey) => {
    cachedRef.current = key;
    setCachedKeyState(key);
    writeSlot(key);
  }, []);

  const setPastedKey = useCallback((value: string) => {
    pastedRef.current = value;
    setPastedKeyState(value);
    if (rememberRef.current) {
      writeSlot(value === '' ? null : { id: PASTED_ID, plaintext: value });
    }
  }, []);

  const setRememberPasted = useCallback((value: boolean) => {
    rememberRef.current = value;
    setRememberPastedState(value);
    if (value) {
      if (pastedRef.current !== '') writeSlot({ id: PASTED_ID, plaintext: pastedRef.current });
    } else if (readSlot()?.id === PASTED_ID) {
      writeSlot(null);
    }
  }, []);

  /** Admin path: return the cached key, minting a dedicated one on first use. */
  const ensureKey = useCallback(async (): Promise<{ key: PlaygroundKey; mintedNow: boolean }> => {
    const current = cachedRef.current;
    if (current !== null) return { key: current, mintedNow: false };
    const created = await apiFetch<PlaygroundKey>('/console/api-keys', {
      method: 'POST',
      body: {},
    });
    setCachedKey(created);
    return { key: created, mintedNow: true };
  }, [setCachedKey]);

  /**
   * Admin path: rotate the cached key (401 self-heal / manual regenerate).
   * Falls back to a fresh mint when the old key row is gone.
   */
  const rotateKey = useCallback(async (): Promise<PlaygroundKey> => {
    const current = cachedRef.current;
    if (current !== null) {
      try {
        const rotated = await apiFetch<PlaygroundKey>(`/console/api-keys/${current.id}/rotate`, {
          method: 'POST',
        });
        setCachedKey(rotated);
        return rotated;
      } catch {
        // The cached key row may have been disabled/deleted elsewhere — mint anew.
      }
    }
    const created = await apiFetch<PlaygroundKey>('/console/api-keys', {
      method: 'POST',
      body: {},
    });
    setCachedKey(created);
    return created;
  }, [setCachedKey]);

  return {
    cachedKey,
    pastedKey,
    setPastedKey,
    rememberPasted,
    setRememberPasted,
    ensureKey,
    rotateKey,
  };
}
