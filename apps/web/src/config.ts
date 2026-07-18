/** Build-time environment contract. All values are `VITE_*` vars baked at build. */
export const config = {
  /** API base URL; empty string = same-origin via dev proxy / nginx. */
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? '',
  /** Whether the Google/GitHub OAuth entrances are shown on the login page. */
  oauthEnabled: import.meta.env.VITE_OAUTH_ENABLED === 'true',
  /** White-label brand name rendered by the shell brand block. */
  brandName: import.meta.env.VITE_BRAND_NAME ?? 'Actionow',
} as const;
