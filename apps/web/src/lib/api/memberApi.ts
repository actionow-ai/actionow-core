import type { ApiClient } from './client';
import type {
  MemberBalanceView,
  MemberKeyView,
  MemberLimitsView,
  MemberMeView,
  MemberUsageList,
} from './types';

/**
 * The end-user self-service **member** client — sibling to `makeConsoleApi`,
 * scoped to the caller's OWN subject (the backend `MemberGuard` derives the
 * subject from the member JWT, never from a body/path). Read-only in v1.
 *
 * Everything goes through the hand-written `rawClient` (carrying the member JWT
 * the `/member/login` flow already stored as `actionow.token`): the `/member/*`
 * routes are NOT in the generated SDK path set — the same precedent as the
 * `/console` limit-plan / sub-wallet helpers — but their views are contract
 * types. Money stays a decimal µ-string. A member token is rejected by every
 * operator plane (`ConsoleGuard`), so this module deliberately makes NO
 * `/console/*` or `/admin/*` calls.
 */
export function makeMemberApi(rawClient: ApiClient) {
  return {
    // The caller's own identity + status.
    me: (): Promise<MemberMeView> => rawClient.get<MemberMeView>('/member/me'),
    // The caller-subject's wallet (hard sub-account, or a shared-pool indicator).
    balance: (): Promise<MemberBalanceView> => rawClient.get<MemberBalanceView>('/member/balance'),
    // The caller-subject's own usage-log rows (keyset envelope; v1 reads the
    // first page — no LoadMore yet).
    usage: (limit?: number): Promise<MemberUsageList> =>
      rawClient.get<MemberUsageList>('/member/usage', limit !== undefined ? { limit } : undefined),
    // The caller-subject's own API keys (masked; never plaintext). The backend
    // `GET /member/api-keys` returns a BARE array (not a keyset envelope, unlike
    // `console.listSubjects`), so this is returned verbatim — no `.data` unwrap.
    apiKeys: (): Promise<MemberKeyView[]> => rawClient.get<MemberKeyView[]>('/member/api-keys'),
    // The caller-subject's governance status (effective plan + usage-vs-cap bars).
    limits: (): Promise<MemberLimitsView> => rawClient.get<MemberLimitsView>('/member/limits'),
  };
}

export type MemberApi = ReturnType<typeof makeMemberApi>;
