// apps/api/src/gateway/models.controller.ts
//
// model-supply-greenfield 批次4 slice3 — the §5 NEW discovery face: the
// models THIS caller can actually use (tenant visibility ∩ key model
// allowlist) with their operation surfaces, paradigms and canonical-contract
// summaries (member 自助面 + key-allowlist config feed on it; replaces the
// old /v1/resources discovery in the new world).
//
// 双面并存处置: the OLD OpenAI-shape `GET /v1/models` (chat/models.controller,
// old-world listVisibleModels) is UNTOUCHED — mounting a second controller on
// the same route would shadow nondeterministically. The new face lives at
// `GET /v1/gateway/models`; slice6's 切换预案 repoints `/v1/models` here by
// swapping the controller path in ONE line once the chat facade migrates.
import type { GatewayModelList, GatewayModelView, ModelOperation } from '@actionow/contracts';
import type { SupplyModelRow } from '@actionow/db';
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import type { AuthedRequest } from '../auth/api-key.guard.js';
import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { GatewayService } from './gateway.service.js';

@ApiTags('v1')
@ApiBearerAuth('api-key')
@UseGuards(ApiKeyGuard)
@Controller('v1/gateway/models')
export class GatewayModelsController {
  constructor(private readonly gateway: GatewayService) {}

  /** §5 发现面: (key 白名单 ∩ 租户可见性), OpenAI list shape + operation/契约扩展. */
  @Get()
  @ApiOperation({
    summary: 'List the models this caller can use (visibility ∩ key allowlist) + contract summary',
  })
  async list(@Req() req: Request): Promise<GatewayModelList> {
    const auth = (req as AuthedRequest).auth;
    const tenantId = auth?.tenantId ?? '';
    const visible = await this.gateway.listVisibleModels(tenantId);
    // §2.6: [] = allow ALL; the dev x-tenant-id fallback (apiKeyId null) has
    // no key and therefore no extra restriction.
    const allowlist =
      auth?.apiKeyId != null ? await this.gateway.modelAllowlist(auth.apiKeyId) : [];
    const usable =
      allowlist.length === 0 ? visible : visible.filter((m) => allowlist.includes(m.name));
    return { object: 'list', data: usable.map(toModelView) };
  }
}

/** SupplyModelRow → the discovery view (OpenAI `model` object + extensions). */
function toModelView(model: SupplyModelRow): GatewayModelView {
  return {
    id: model.name,
    object: 'model',
    created: Math.floor(model.createdAt.getTime() / 1000),
    owned_by: 'actionow',
    display_name: model.displayName,
    modality: model.modality,
    status: model.status,
    operations: model.operations.map((op) => toOperationView(op)),
    capabilities: model.capabilities,
  };
}

function toOperationView(op: ModelOperation): GatewayModelView['operations'][number] {
  return {
    operation: op.operation,
    paradigms: op.paradigms,
    slow: op.slow,
    params: op.params.map((p) => ({
      name: p.name,
      type: p.type,
      required: p.required,
      billing_relevant: p.billingRelevant,
      ...(p.default !== undefined ? { default: p.default } : {}),
      ...(p.values !== undefined ? { values: p.values } : {}),
      ...(p.min !== undefined ? { min: p.min } : {}),
      ...(p.max !== undefined ? { max: p.max } : {}),
      ...(p.multiple !== undefined ? { multiple: p.multiple } : {}),
    })),
  };
}
