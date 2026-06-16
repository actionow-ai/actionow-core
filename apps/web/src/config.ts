export const config = {
  /** API origin; '' means same-origin (dev uses the Vite proxy to :3000). */
  apiBase: import.meta.env.VITE_API_BASE_URL ?? '',
  /** Unified auth base path (Phase 9). */
  authBase: '/auth',
  /** Reserve OAuth buttons until the backend wires the SPA redirect handoff. */
  oauthEnabled: import.meta.env.VITE_OAUTH_ENABLED === 'true',
};
