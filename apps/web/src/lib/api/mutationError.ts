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
