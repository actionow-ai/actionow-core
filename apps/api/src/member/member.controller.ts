import {
  type MemberBalanceView,
  memberBalanceViewSchema,
  memberChangePasswordSchema,
  memberCreateApiKeySchema,
  type MemberKeyCreatedView,
  type MemberKeyView,
  memberKeyViewSchema,
  type MemberLimitsView,
  memberLimitsViewSchema,
  type MemberMeView,
  memberMeViewSchema,
  type MemberUpdateMeBody,
  memberUpdateMeSchema,
  type MemberUsageList,
  memberUsageListSchema,
} from '@actionow/contracts';
import type { ApiKeyRow, SubjectRow, UsageLogRow } from '@actionow/db';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Audit } from '../audit/audit.decorator.js';
import { AuditInterceptor } from '../audit/audit.interceptor.js';
import { engineUnauthorized } from '../common/errors.js';
import { encodeCursor, toPageParams } from '../common/pagination.js';
import { ZodBody } from '../common/zod.pipe.js';
import type { MemberChangePasswordDto, MemberCreateApiKeyDto } from './dto/member.dto.js';
import { type MemberContext, MemberGuard, type MemberRequest } from './member.guard.js';
import type { MemberBalance, MemberLimits } from './member.service.js';
import { MemberService } from './member.service.js';

/** Read the guard-populated member context, or fail closed with `unauthorized`. */
function ctxOf(req: MemberRequest): MemberContext {
  if (req.member === undefined) throw engineUnauthorized('request is not authenticated');
  return req.member;
}

/** Project the caller-subject row to the member identity view (NEVER the password hash). */
function toMeView(s: SubjectRow): MemberMeView {
  return memberMeViewSchema.parse({
    id: s.id,
    status: s.status,
    tenant_id: s.tenantId,
    external_id: s.externalId,
    email: s.email,
    display_name: s.displayName,
  });
}

/**
 * Project one usage-log row to the member view. Deliberately omits `subject_id`
 * (every row is already the caller's own — the token scopes it); `cost` is a µUSD
 * decimal string (bigint serialized), token counts/latency are numbers.
 */
function toUsageRow(r: UsageLogRow): MemberUsageList['data'][number] {
  return {
    id: r.id,
    model: r.model,
    input_tokens: r.inputTokens,
    output_tokens: r.outputTokens,
    cost: r.cost.toString(),
    latency_ms: r.latencyMs,
    status: r.status,
    created_at: r.createdAt.toISOString(),
  };
}

/** Project the caller-subject's wallet to the mode-tagged balance view (money as strings). */
function toBalanceView(b: MemberBalance): MemberBalanceView {
  return memberBalanceViewSchema.parse({
    mode: b.mode,
    balance: b.balance.toString(),
    held: b.held.toString(),
  });
}

/**
 * Project one of the caller-subject's keys to the masked member view. The api_key
 * table stores only a sha256 `hash` (the plaintext is unrecoverable) and has no
 * `name` column, so `name` is null and `last4` is the tail of the key id — a
 * stable recognizer that leaks neither the plaintext nor the hash.
 */
function toKeyView(k: Omit<ApiKeyRow, 'hash'>): MemberKeyView {
  return memberKeyViewSchema.parse({
    id: k.id,
    name: null,
    status: k.status,
    created_at: k.createdAt.toISOString(),
    last4: k.id.slice(-4),
  });
}

/** Project the caller-subject's governance status to the member limits view (caps/usage as strings). */
function toLimitsView(l: MemberLimits): MemberLimitsView {
  return memberLimitsViewSchema.parse({
    plan: l.plan,
    rules: l.rules.map((r) => ({
      dimension: r.dimension,
      period: r.period,
      cap: r.cap.toString(),
      used: r.used.toString(),
      model_scope: r.modelScope,
      alert_pct: r.alertPct,
      enforce: r.enforce,
    })),
  });
}

/**
 * The end-user self-service plane (`/member/*`, Part B). Every route is gated by
 * the {@link MemberGuard} (MEMBER JWT → `{subjectId, tenantId}`) and locked to the
 * caller's OWN subject — the `subjectId`/`tenantId` come from the guard, NEVER
 * from a body/query/path, so an end-user can only ever READ (identity, usage,
 * wallet, keys, limits) OR WRITE its own data (patch profile, change password,
 * self-mint + revoke its own keys) without a tenant-admin. The revoke is filtered
 * on `subject_id` too, so a member can't revoke a sibling subject's (or a tenant-
 * level) key — a non-owned id is a 404. An operator/admin token is rejected by the
 * guard (it carries no `typ:'subject'`); a member token stays rejected on
 * `/console`. Money is serialized as decimal µ-unit strings (bigint), never a float.
 */
@ApiTags('member')
@ApiBearerAuth('jwt')
@UseGuards(MemberGuard)
// 记录系统: `@Audit(...)` member mutations emit an audit_log row (actor = the
// end-user subject, `actor_type='member'`). Best-effort; never fails the write.
@UseInterceptors(AuditInterceptor)
@Controller('member')
export class MemberController {
  constructor(private readonly member: MemberService) {}

  @Get('me')
  @ApiOperation({ summary: 'Your own identity + status (no password hash)' })
  async me(@Req() req: MemberRequest): Promise<MemberMeView> {
    const ctx = ctxOf(req);
    return toMeView(await this.member.me(ctx.subjectId, ctx.tenantId));
  }

  @Get('usage')
  @ApiOperation({ summary: 'Your own per-call usage log (keyset, newest-first)' })
  async usage(
    @Req() req: MemberRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<MemberUsageList> {
    const ctx = ctxOf(req);
    const { rows, hasMore } = await this.member.usage(
      ctx.subjectId,
      ctx.tenantId,
      toPageParams({ cursor, limit }),
    );
    const last = rows.at(-1);
    const next_cursor =
      hasMore && last !== undefined ? encodeCursor(last.createdAt, last.id) : null;
    return memberUsageListSchema.parse({ data: rows.map(toUsageRow), next_cursor });
  }

  @Get('balance')
  @ApiOperation({ summary: 'Your own wallet balance (hard sub-wallet, or shared pool indicator)' })
  async balance(@Req() req: MemberRequest): Promise<MemberBalanceView> {
    const ctx = ctxOf(req);
    return toBalanceView(await this.member.balance(ctx.subjectId, ctx.tenantId));
  }

  @Get('api-keys')
  @ApiOperation({ summary: 'Your own API keys (masked; never plaintext)' })
  async keys(@Req() req: MemberRequest): Promise<MemberKeyView[]> {
    const ctx = ctxOf(req);
    return (await this.member.keys(ctx.subjectId, ctx.tenantId)).map(toKeyView);
  }

  @Get('limits')
  @ApiOperation({ summary: 'Your own effective limit plan + usage-vs-cap' })
  async limits(@Req() req: MemberRequest): Promise<MemberLimitsView> {
    const ctx = ctxOf(req);
    return toLimitsView(await this.member.limits(ctx.subjectId, ctx.tenantId));
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update your own profile (display name only)' })
  @Audit({ action: 'member.profile.update', target: 'subject' })
  async updateMe(
    @Req() req: MemberRequest,
    @Body(new ZodBody(memberUpdateMeSchema)) body: MemberUpdateMeBody,
  ): Promise<MemberMeView> {
    const ctx = ctxOf(req);
    const updated = await this.member.updateProfile(ctx.subjectId, ctx.tenantId, {
      displayName: body.display_name,
    });
    return toMeView(updated);
  }

  @Post('me/password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Change your own password (verifies current; Model-A only)' })
  @Audit({ action: 'member.password.change', target: 'subject' })
  async changePassword(
    @Req() req: MemberRequest,
    @Body(new ZodBody(memberChangePasswordSchema)) body: MemberChangePasswordDto,
  ): Promise<{ ok: true }> {
    const ctx = ctxOf(req);
    await this.member.changePassword(ctx.subjectId, ctx.tenantId, body);
    return { ok: true };
  }

  @Post('api-keys')
  @HttpCode(201)
  @ApiOperation({ summary: 'Self-mint a subject-scoped API key (plaintext returned once)' })
  // NEVER record the plaintext — only the created key id.
  @Audit({
    action: 'member.api_key.create',
    target: 'api_key',
    resolve: ({ result }) => ({ targetId: (result as { id?: string }).id ?? null }),
  })
  async createApiKey(
    @Req() req: MemberRequest,
    @Body(new ZodBody(memberCreateApiKeySchema)) body: MemberCreateApiKeyDto,
  ): Promise<MemberKeyCreatedView> {
    const ctx = ctxOf(req);
    const created = await this.member.createApiKey(ctx.subjectId, ctx.tenantId, body);
    return { id: created.id, plaintext: created.plaintext };
  }

  @Delete('api-keys/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revoke one of YOUR OWN API keys (cross-subject id → 404)' })
  @Audit({
    action: 'member.api_key.revoke',
    target: 'api_key',
    resolve: ({ params }) => ({ targetId: params.id ?? null }),
  })
  async revokeApiKey(
    @Req() req: MemberRequest,
    @Param('id') id: string,
  ): Promise<{ id: string; status: 'revoked' }> {
    const ctx = ctxOf(req);
    await this.member.revokeApiKey(ctx.subjectId, ctx.tenantId, id);
    return { id, status: 'revoked' };
  }
}
