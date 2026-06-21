export const config = {
  /** API origin; '' means same-origin (dev uses the Vite proxy to :3000). */
  apiBase: import.meta.env.VITE_API_BASE_URL ?? '',
  /** Unified auth base path (Phase 9). */
  authBase: '/auth',
  /** Reserve OAuth buttons until the backend wires the SPA redirect handoff. */
  oauthEnabled: import.meta.env.VITE_OAUTH_ENABLED === 'true',
  /** White-label brand wordmark — shown in the logo/footer/title (default Actionow). */
  brandName: import.meta.env.VITE_BRAND_NAME ?? 'Actionow',
  /**
   * Deployment mode. `marketing` (default) serves the Landing page at `/`;
   * `app` is a white-label SaaS with no marketing site, so `/` redirects straight
   * to the caller's home (login / tenant console / admin console).
   */
  deploymentMode: import.meta.env.VITE_DEPLOYMENT_MODE === 'app' ? 'app' : 'marketing',
};
