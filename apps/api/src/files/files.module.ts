import type { StorageProvider, StorageProviderConfig } from '@actionow/contracts';
import type { AppEnv } from '@actionow/infra';
import { createS3StorageProvider } from '@actionow/infra';
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
 * Assemble a {@link StorageProviderConfig} from env, or `null` when any required
 * field is missing. The optional `endpoint`/`forcePathStyle` are only included
 * when set so the SDK derives AWS defaults otherwise.
 */
function storageConfigFromEnv(env: AppEnv): StorageProviderConfig | null {
  const { STORAGE_PROVIDER, STORAGE_BUCKET, STORAGE_REGION } = env;
  const { STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY } = env;
  if (
    STORAGE_PROVIDER === undefined ||
    STORAGE_BUCKET === undefined ||
    STORAGE_REGION === undefined ||
    STORAGE_ACCESS_KEY_ID === undefined ||
    STORAGE_SECRET_ACCESS_KEY === undefined
  ) {
    return null;
  }
  const cfg: StorageProviderConfig = {
    kind: STORAGE_PROVIDER,
    bucket: STORAGE_BUCKET,
    region: STORAGE_REGION,
    accessKeyId: STORAGE_ACCESS_KEY_ID,
    secretAccessKey: STORAGE_SECRET_ACCESS_KEY,
  };
  if (env.STORAGE_ENDPOINT !== undefined) cfg.endpoint = env.STORAGE_ENDPOINT;
  if (env.STORAGE_FORCE_PATH_STYLE !== undefined) cfg.forcePathStyle = env.STORAGE_FORCE_PATH_STYLE;
  return cfg;
}

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
