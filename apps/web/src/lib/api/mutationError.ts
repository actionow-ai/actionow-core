import type { TFunction } from 'i18next';

import { toast } from '../../components/ui/toast';
import { ApiError } from './errors';

/** Standard onError for useMutation: localized error toast, server-message fallback. */
export function mutationError(t: TFunction) {
  return (e: unknown) => {
    if (e instanceof ApiError) toast(t(`errors.${e.code}`, e.message), 'error');
    else toast(t('errors.network'), 'error');
  };
}

/**
 * The raw error message for a non-toast surface (an inline error state). Returns
 * the server message for an {@link ApiError}, else a generic `'network'` sentinel
 * the caller can localize. Not localized here (callers without a `t` use it).
 */
export function mutationErrorMessage(e: unknown): string {
  return e instanceof ApiError ? e.message : 'network';
}
