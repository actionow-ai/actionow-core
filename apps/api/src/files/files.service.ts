import { randomUUID } from 'node:crypto';

import type { IoSchema, StorageProvider } from '@actionow/contracts';
import type { FileReadyInput } from '@actionow/db';
import {
  createFileObject,
  type Database,
  type FileObject,
  getFileObject,
  markFileReady,
} from '@actionow/db';
import type { AppEnv } from '@actionow/infra';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantContext } from '../auth/auth.service.js';
import { engineInvalidInput, engineNotFound } from '../common/errors.js';
import { DB, ENV, STORAGE } from '../common/tokens.js';

/** A presigned-upload grant returned by {@link FilesService.presignUpload}. */
export interface PresignUploadResult {
  file_id: string;
  upload_url: string;
  key: string;
  expires_in: number;
}

/** A presigned-download grant returned by {@link FilesService.getUrl}. */
export interface FileUrlResult {
  url: string;
  expires_in: number;
}

/** The public view of a confirmed `file_object` row. */
export interface FileView {
  id: string;
  status: string;
  size: number | null;
  content_type: string | null;
  etag: string | null;
}

/**
 * Owns the `/v1/files` lifecycle over the injected {@link StorageProvider}:
 * mint a presigned upload + a `pending` reference, confirm the upload via
 * `head` and flip it `ready`, and mint presigned download URLs — all
 * tenant-scoped. Also exposes {@link resolveFileInputs}, which maps io_schema
 * `file`/`file_list` inputs (carrying a `file_id`) to presigned GET URLs before
 * a run hands inputs to an adapter.
 *
 * Storage may be unconfigured (the API boots without `STORAGE_*`); in that case
 * the provider is `null` and every storage-backed call fails closed with
 * `invalid_input` rather than crashing the app at boot.
 *
 * Credentials and presigned signatures are never logged.
 */
@Injectable()
export class FilesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: AppEnv,
    @Inject(STORAGE) private readonly storage: StorageProvider | null,
  ) {}

  /**
   * Issue a presigned PUT and persist a `pending` reference. The object key is
   * server-generated (`{tenantId}/{uuid}.{ext}`) so a client cannot smuggle a
   * cross-tenant prefix; the extension is derived from the (validated) filename.
   */
  async presignUpload(
    body: { filename: string; content_type: string; size: number },
    ctx: TenantContext,
  ): Promise<PresignUploadResult> {
    const storage = this.requireStorage();
    if (body.size > this.env.STORAGE_MAX_UPLOAD_BYTES) {
      throw engineInvalidInput(
        `upload size ${String(body.size)} exceeds the maximum of ${String(this.env.STORAGE_MAX_UPLOAD_BYTES)} bytes`,
      );
    }

    const key = buildKey(ctx.tenantId, body.filename);
    const file = await createFileObject(this.db, {
      tenantId: ctx.tenantId,
      provider: storage.kind,
      bucket: this.bucket(),
      key,
    });

    const presign = await storage.presignPut(key, { contentType: body.content_type });
    return {
      file_id: file.id,
      upload_url: presign.url,
      key,
      expires_in: presign.expiresIn,
    };
  }

  /**
   * Confirm an upload: tenant-scoped lookup, then `head` the object. If it
   * exists, record the observed metadata and flip the row `ready`; a missing
   * object is `invalid_input` (the client claimed an upload that never landed).
   * An unknown / cross-tenant `id` is 404 `resource_not_found`.
   */
  async confirm(id: string, ctx: TenantContext): Promise<FileView> {
    const storage = this.requireStorage();
    const file = await this.requireFile(id, ctx.tenantId);

    const head = await storage.head(file.key);
    if (!head.exists) {
      throw engineInvalidInput(`no uploaded object found for file ${id}`);
    }

    const meta: FileReadyInput = {};
    if (head.size !== undefined) meta.size = head.size;
    if (head.contentType !== undefined) meta.contentType = head.contentType;
    if (head.etag !== undefined) meta.etag = head.etag;

    const updated = await markFileReady(this.db, file.id, meta);
    return toView(updated ?? file);
  }

  /** Mint a presigned GET URL for a tenant-owned file. 404 if not visible. */
  async getUrl(id: string, ctx: TenantContext): Promise<FileUrlResult> {
    const storage = this.requireStorage();
    const file = await this.requireFile(id, ctx.tenantId);
    const presign = await storage.presignGet(file.key);
    return { url: presign.url, expires_in: presign.expiresIn };
  }

  /**
   * Replace io_schema `file`/`file_list` input values — each a `file_id` (or an
   * array of them) — with presigned GET URLs, so adapters receive directly
   * fetchable URLs instead of opaque ids. Inputs whose schema field is not a
   * file type pass through untouched. Each referenced file must be tenant-owned
   * and `ready`, else `invalid_input`.
   *
   * Wired as an exported helper for RunService; the returned object is a shallow
   * copy with only the file fields rewritten.
   */
  async resolveFileInputs(
    ioSchema: IoSchema,
    inputs: Record<string, unknown>,
    ctx: TenantContext,
  ): Promise<Record<string, unknown>> {
    const resolved: Record<string, unknown> = { ...inputs };
    for (const field of ioSchema.inputs) {
      if (field.type !== 'file' && field.type !== 'file_list') continue;
      const value = inputs[field.key];
      if (value === undefined || value === null) continue;

      if (field.type === 'file') {
        resolved[field.key] = await this.fileIdToUrl(value, field.key, ctx);
      } else {
        if (!Array.isArray(value)) {
          throw engineInvalidInput(`input "${field.key}" must be an array of file ids`);
        }
        resolved[field.key] = await Promise.all(
          value.map((v) => this.fileIdToUrl(v, field.key, ctx)),
        );
      }
    }
    return resolved;
  }

  /** Resolve a single `file_id` value to a presigned GET URL (tenant + ready scoped). */
  private async fileIdToUrl(value: unknown, fieldKey: string, ctx: TenantContext): Promise<string> {
    if (typeof value !== 'string' || value === '') {
      throw engineInvalidInput(`input "${fieldKey}" must be a file id`);
    }
    const storage = this.requireStorage();
    const file = await getFileObject(this.db, value, ctx.tenantId);
    if (file === undefined) {
      throw engineInvalidInput(`file ${value} not found for input "${fieldKey}"`);
    }
    if (file.status !== 'ready') {
      throw engineInvalidInput(`file ${value} is not ready for input "${fieldKey}"`);
    }
    const presign = await storage.presignGet(file.key);
    return presign.url;
  }

  /** Tenant-scoped fetch or 404 (cross-tenant ids are indistinguishable from missing). */
  private async requireFile(id: string, tenantId: string): Promise<FileObject> {
    const file = await getFileObject(this.db, id, tenantId);
    if (file === undefined) {
      throw engineNotFound(`file ${id} not found`);
    }
    return file;
  }

  /** The configured provider, or `invalid_input` when storage is unconfigured. */
  private requireStorage(): StorageProvider {
    if (this.storage === null) {
      throw engineInvalidInput('object storage is not configured');
    }
    return this.storage;
  }

  /** The default bucket name from env (guaranteed set whenever storage exists). */
  private bucket(): string {
    return this.env.STORAGE_BUCKET ?? '';
  }
}

/**
 * The server-side object key: `{tenantId}/{uuid}.{ext}`. The extension is the
 * lowercased suffix of the (validated, non-empty) filename, or omitted when the
 * filename has none.
 */
function buildKey(tenantId: string, filename: string): string {
  const ext = extensionOf(filename);
  const base = `${tenantId}/${randomUUID()}`;
  return ext === undefined ? base : `${base}.${ext}`;
}

/** The lowercase extension of a filename (no leading dot), or undefined. */
function extensionOf(filename: string): string | undefined {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return undefined;
  return filename.slice(dot + 1).toLowerCase();
}

/** Project a `file_object` row to its public {@link FileView}. */
function toView(file: FileObject): FileView {
  return {
    id: file.id,
    status: file.status,
    size: file.size,
    content_type: file.contentType,
    etag: file.etag,
  };
}
