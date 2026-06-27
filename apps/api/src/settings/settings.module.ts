import { Global, Module } from '@nestjs/common';

import { AdminModule } from '../admin/admin.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { SettingsController } from './settings.controller.js';
import { SettingsService } from './settings.service.js';

/**
 * Global dynamic-config module (动态配置). Exports {@link SettingsService} (a
 * cached env→DB overlay) so ANY guard/service can read effective settings by
 * injecting it — `@Optional()` at the call site, so a partial test module
 * without this import simply falls back to env (today's behavior). The admin
 * CRUD lives on `/admin/settings` (AdminGuard + audited); imports AdminModule
 * for the guard. `DB`/`ENV` come from the global `DbModule`.
 */
@Global()
@Module({
  imports: [AdminModule, AuditModule],
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class SettingsModule {}
