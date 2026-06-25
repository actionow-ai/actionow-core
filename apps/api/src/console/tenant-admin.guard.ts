import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

import { engineForbidden, engineUnauthorized } from '../common/errors.js';
import type { ConsoleRequest } from './console.guard.js';

/**
 * Runs AFTER {@link ConsoleGuard} on tenant-admin-only console routes: requires
 * `req.console.tenantRole === 'admin'`, else 403. A tenant member hits this.
 */
@Injectable()
export class TenantAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ConsoleRequest>();
    if (req.console === undefined) throw engineUnauthorized('request is not authenticated');
    if (req.console.tenantRole !== 'admin') {
      throw engineForbidden('tenant admin role required');
    }
    return true;
  }
}
