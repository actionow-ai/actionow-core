import { Navigate } from 'react-router-dom';

import { config } from './config';
import { LandingPage } from './features/landing/LandingPage';
import { useAuth } from './lib/auth/AuthProvider';
import { homePath } from './lib/auth/homePath';

// `homePath` now lives in `lib/auth/homePath` (so the landing `Nav` can import it
// without a RootRoute↔LandingPage↔Nav cycle). Re-exported here for the existing
// callers/tests that import it from this module.
export { homePath };

/** `app` mode has no Landing — `/` lands the caller at their home. */
function HomeRedirect() {
  const { user } = useAuth();
  return <Navigate to={homePath(user)} replace />;
}

/**
 * The `/` route, switched by the deployment mode (white-label config). In
 * `marketing` mode (the default) it serves the LandingPage; in `app` mode it
 * redirects straight to the caller's home so a white-label operator can run the
 * product without exposing the marketing site.
 */
export function RootRoute() {
  if (config.deploymentMode === 'marketing') return <LandingPage />;
  return <HomeRedirect />;
}
