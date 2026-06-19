import type { StorageProvider } from '@actionow/contracts';
import type { AppEnv } from '@actionow/infra';
import { createS3StorageProvider, storageConfigFromEnv } from '@actionow/infra';
import type { Provider } from '@nestjs/common';
import { Logger, Module } from '@nestjs/common';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { ENV, STORAGE } from '../common/tokens.js';
import { FilesController } from './files.controller.js';
import { FilesService } from './files.service.js';

/**
 * The default {@link StorageProvider} built from `STORAGE_*` env. Returns `null`
 * when storage is unconfigured (missing provider/bucket/region/creds) so the API
 * still boots; the `/v1/files` service then fails closed with `invalid_input`.
 * Credentials are never logged — only whether storage was configured.
 */
const storageProvider: Provider = {
  provide: STORAGE,
  inject: [ENV],
  useFactory: (env: AppEnv): StorageProvider | null => {
    const cfg = storageConfigFromEnv(env);
    const logger = new Logger('Storage');
    if (cfg === null) {
      logger.log('object storage not configured (STORAGE_* unset) — /v1/files disabled');
      return null;
    }
    logger.log(`object storage configured: ${cfg.kind} bucket "${cfg.bucket}"`);
    return createS3StorageProvider(cfg);
  },
};

/**
 * Wires `/v1/files` ({@link FilesController}) over the default
 * {@link StorageProvider} (token {@link STORAGE}). `FilesService` is exported so
 * other modules (e.g. execution's RunService) can reuse {@link
 * FilesService.resolveFileInputs}.
 */
@Module({
  controllers: [FilesController],
  providers: [storageProvider, FilesService, AuthService, ApiKeyGuard],
  exports: [FilesService, STORAGE],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class FilesModule {}
