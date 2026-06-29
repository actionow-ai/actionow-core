import { useCallback, useEffect, useRef, useState } from 'react';

import { mutationErrorMessage } from '../../../lib/api/mutationError';
import { useConsoleApi } from '../../../lib/api/useConsoleApi';

/** The cached playground key — its id (for rotation) + the plaintext (for `/v1` calls). */
interface PlaygroundKey {
  id: string;
  plaintext: string;
}

const STORAGE_KEY = 'actionow.playground_key';

function loadCached(): PlaygroundKey | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<PlaygroundKey>;
    if (typeof parsed.id === 'string' && typeof parsed.plaintext === 'string') {
      return { id: parsed.id, plaintext: parsed.plaintext };
    }
  } catch {
    // corrupt cache → treat as absent (we'll re-mint).
  }
  return null;
}

function storeCached(key: PlaygroundKey): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(key));
}

function clearCached(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export interface PlaygroundKeyState {
  /** The plaintext key to send as `Authorization: Bearer …` to `/v1/*`, or null until ready. */
  readonly key: string | null;
  readonly ready: boolean;
  readonly error: string | null;
  /**
   * Recover after a 401 (the cached key was revoked/rotated elsewhere): rotate the
   * cached key id for a fresh plaintext, or mint a brand-new key. Returns the new
   * plaintext (or null on failure).
   */
  readonly recover: () => Promise<string | null>;
}

/**
 * Provisions a dedicated tenant API key for the playground's browser-side `/v1`
 * calls (decision: the operator owns their own keys, so a key in *their* browser
 * is acceptable here). The key is auto-managed and never surfaced to the user:
 *
 * - cached `{ id, plaintext }` in `localStorage` and reused across sessions;
 * - minted on first use (api keys have no server-side name, so the "playground
 *   key" is identified by its localStorage slot, which also isolates its usage
 *   for billing attribution);
 * - on a 401 (`recover`), rotated for a fresh plaintext (or re-minted if the row
 *   is gone), so a key revoked from the Keys page self-heals.
 */
export function usePlaygroundKey(): PlaygroundKeyState {
  const api = useConsoleApi();
  const [state, setState] = useState<{ key: PlaygroundKey | null; error: string | null }>({
    key: loadCached(),
    error: null,
  });
  // Guard the one-shot mint against StrictMode's double-effect + api identity churn.
  const mintingRef = useRef(false);

  useEffect(() => {
    if (state.key !== null || mintingRef.current) return;
    mintingRef.current = true;
    let cancelled = false;
    void api
      .createApiKey({})
      .then((created) => {
        if (cancelled) return;
        const key = { id: created.id, plaintext: created.plaintext };
        storeCached(key);
        setState({ key, error: null });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        mintingRef.current = false; // allow a retry on the next mount/recover
        setState({ key: null, error: mutationErrorMessage(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [api, state.key]);

  const recover = useCallback(async (): Promise<string | null> => {
    const cached = loadCached();
    try {
      if (cached !== null) {
        const rotated = await api.rotateApiKey(cached.id);
        const key = { id: rotated.id, plaintext: rotated.plaintext };
        storeCached(key);
        setState({ key, error: null });
        return key.plaintext;
      }
    } catch {
      // the cached key id is gone → fall through to a fresh mint.
    }
    try {
      clearCached();
      const created = await api.createApiKey({});
      const key = { id: created.id, plaintext: created.plaintext };
      storeCached(key);
      setState({ key, error: null });
      return key.plaintext;
    } catch (e) {
      setState({ key: null, error: mutationErrorMessage(e) });
      return null;
    }
  }, [api]);

  return {
    key: state.key?.plaintext ?? null,
    ready: state.key !== null,
    error: state.error,
    recover,
  };
}
