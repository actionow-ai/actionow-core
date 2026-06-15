import { SetMetadata } from '@nestjs/common';

/** Reflector metadata key under which {@link Roles} stores its required roles. */
export const ROLES_KEY = 'admin:roles';

/**
 * Restrict a route (or controller) to admins whose JWT `role` is in `roles`.
 * Read by the {@link AdminGuard}; absent metadata means "any authenticated
 * admin".
 */
export const Roles = (...roles: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
