/**
 * Where an authenticated visitor belongs, by role. Shared by `RootRoute` (the
 * `/` redirect in `app` deployment mode) and the landing `Nav` CTA so both route
 * to the SAME place: anonymous → login, admin → the operator console, any other
 * authed user → the tenant self-service app. Lives in its own module (not in
 * `RootRoute`) so `Nav` can import it without a `RootRoute ↔ LandingPage ↔ Nav`
 * import cycle.
 */
export function homePath(user: { role: string } | null): string {
  if (!user) return '/login';
  return user.role === 'admin' ? '/console/dashboard' : '/app';
}
