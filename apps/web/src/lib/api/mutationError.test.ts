import type { TFunction } from 'i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { toast } from '../../components/ui/toast';
import { ApiError } from './errors';
import { mutationError } from './mutationError';

vi.mock('../../components/ui/toast', () => ({ toast: vi.fn() }));

const toastMock = vi.mocked(toast);

/**
 * A fake `t` mirroring i18next semantics: a known key resolves to its key string
 * (proving localization fired); an unknown key returns the `defaultValue` arg
 * (proving the server-message fallback fired).
 */
const KNOWN = new Set(['errors.insufficient_credits', 'errors.network']);
const t = ((key: string, fallback?: string) =>
  KNOWN.has(key) ? key : (fallback ?? key)) as unknown as TFunction;

beforeEach(() => {
  toastMock.mockClear();
});

describe('mutationError', () => {
  it('toasts the localized message for a known error code', () => {
    mutationError(t)(new ApiError('insufficient_credits', 'server msg', 402, false));
    expect(toastMock).toHaveBeenCalledWith('errors.insufficient_credits', 'error');
  });

  it('falls back to the server message for an unknown code', () => {
    mutationError(t)(new ApiError('totally_unknown_code', 'server msg', 400, false));
    expect(toastMock).toHaveBeenCalledWith('server msg', 'error');
  });

  it('toasts the network error for a non-ApiError', () => {
    mutationError(t)(new Error('boom'));
    expect(toastMock).toHaveBeenCalledWith('errors.network', 'error');
  });
});
