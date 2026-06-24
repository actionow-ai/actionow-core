import { Module } from '@nestjs/common';

import { AuditInterceptor } from './audit.interceptor.js';
import { AuditService } from './audit.service.js';

/**
 * Provides the records-system audit writer + the `@Audit` interceptor. DB is the
 * global drizzle handle, so this module only needs to register the two providers
 * and export them for the admin + console controllers to use.
 */
@Module({
  providers: [AuditService, AuditInterceptor],
  exports: [AuditService, AuditInterceptor],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class AuditModule {}
