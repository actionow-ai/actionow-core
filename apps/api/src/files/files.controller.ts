import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { type PageEnvelope, toPageParams } from '../common/pagination.js';
import { ZodBody } from '../common/zod.pipe.js';
import { type PresignUploadDto, presignUploadSchema } from './dto/files.dto.js';
import type {
  FileUrlResult,
  FileView,
  PresignUploadResult,
  StorageUsageView,
} from './files.service.js';
import { FilesService } from './files.service.js';

/**
 * The `/v1/files` surface (Phase 7): presigned upload, confirm, and download
 * over an S3-compatible bucket, all scoped to the caller's tenant by
 * {@link ApiKeyGuard} + {@link AuthService}. Errors map to the §4.7 envelope via
 * the global {@link UnifiedErrorFilter} (invalid_input → 400, resource_not_found
 * → 404, unauthorized → 401).
 */
@ApiTags('v1')
@ApiBearerAuth('api-key')
@UseGuards(ApiKeyGuard)
@Controller('v1/files')
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly auth: AuthService,
  ) {}

  /** List the caller's files newest-first, keyset-paginated; optional `status` filter. */
  @Get()
  @ApiOperation({ summary: 'List the caller’s files (keyset, paginated)' })
  async list(
    @Req() req: Request,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ): Promise<PageEnvelope<FileView>> {
    const ctx = this.auth.resolve(req);
    const filter: { status?: 'pending' | 'ready' } = {};
    if (status === 'pending' || status === 'ready') filter.status = status;
    return this.files.list(ctx, filter, toPageParams({ cursor, limit }));
  }

  /** Issue a presigned PUT + a `pending` reference. */
  @Post('presign-upload')
  @HttpCode(200)
  @ApiOperation({ summary: 'Presign a file upload (returns a PUT URL + file_id)' })
  async presignUpload(
    @Body(new ZodBody(presignUploadSchema)) dto: PresignUploadDto,
    @Req() req: Request,
  ): Promise<PresignUploadResult> {
    const ctx = this.auth.resolve(req);
    return this.files.presignUpload(dto, ctx);
  }

  /** Confirm an upload landed (head) and flip the reference `ready`. */
  @Post(':id/confirm')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirm an uploaded file (head → ready)' })
  async confirm(@Param('id') id: string, @Req() req: Request): Promise<FileView> {
    const ctx = this.auth.resolve(req);
    return this.files.confirm(id, ctx);
  }

  /** Mint a presigned GET URL for a tenant-owned file. */
  @Get(':id/url')
  @ApiOperation({ summary: 'Get a presigned download URL for a file' })
  async getUrl(@Param('id') id: string, @Req() req: Request): Promise<FileUrlResult> {
    const ctx = this.auth.resolve(req);
    return this.files.getUrl(id, ctx);
  }

  /** The caller-tenant's object-storage usage + effective quota (for chargeback / quota UX). */
  @Get('usage')
  @ApiOperation({ summary: 'Get the caller’s object-storage usage + quota' })
  async usage(@Req() req: Request): Promise<StorageUsageView> {
    const ctx = this.auth.resolve(req);
    return this.files.usage(ctx);
  }

  /** Soft-delete a tenant-owned file: tombstone the reference + remove the object. */
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a file (tombstone + remove from bucket)' })
  async remove(@Param('id') id: string, @Req() req: Request): Promise<void> {
    const ctx = this.auth.resolve(req);
    await this.files.delete(id, ctx);
  }
}
