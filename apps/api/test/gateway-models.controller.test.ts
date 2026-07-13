// 批次4 slice3 — GatewayModelsController unit tests: the §5 discovery face =
// tenant visibility ∩ key model-allowlist, OpenAI list shape + the
// operations/paradigms/contract-summary extensions.
import { describe, expect, it, vi } from 'vitest';

import type { GatewayService } from '../src/gateway/gateway.service.js';
import { GatewayModelsController } from '../src/gateway/models.controller.js';
import { AUTH, fakeReq, modelRow } from './gateway-fixtures.js';

function controllerWith(models = [modelRow()], allowlist: string[] = []) {
  const gateway = {
    listVisibleModels: vi.fn().mockResolvedValue(models),
    modelAllowlist: vi.fn().mockResolvedValue(allowlist),
  };
  return {
    controller: new GatewayModelsController(gateway as unknown as GatewayService),
    gateway,
  };
}

describe('GET /v1/gateway/models — §5 发现面', () => {
  it('renders the OpenAI list shape with the operation/contract extensions', async () => {
    const { controller } = controllerWith();
    const body = await controller.list(fakeReq());
    expect(body.object).toBe('list');
    expect(body.data).toHaveLength(1);
    const model = body.data[0];
    expect(model).toMatchObject({
      id: 'seedance-pro',
      object: 'model',
      owned_by: 'actionow',
      display_name: 'Seedance Pro',
      modality: 'video',
      status: 'active',
    });
    expect(model?.operations[0]).toMatchObject({
      operation: 'video.generation',
      paradigms: ['task'],
      slow: false,
    });
    expect(model?.operations[0]?.params).toEqual([
      { name: 'prompt', type: 'string', required: true, billing_relevant: false },
      {
        name: 'resolution',
        type: 'enum',
        required: false,
        billing_relevant: true,
        default: '720p',
        values: ['720p', '1080p'],
      },
    ]);
    // the §3 slow 升格标记 surfaces for SDK submit-and-wait helpers
    expect(model?.operations[1]).toMatchObject({ operation: 'images.generation', slow: true });
  });

  it('intersects tenant visibility with the key allowlist', async () => {
    const models = [modelRow(), modelRow({ id: 'model-2', name: 'other-model' })];
    const { controller } = controllerWith(models, ['other-model']);
    const body = await controller.list(fakeReq());
    expect(body.data.map((m) => m.id)).toEqual(['other-model']);
  });

  it('an empty allowlist means ALL visible models (§2.6 frozen semantics)', async () => {
    const models = [modelRow(), modelRow({ id: 'model-2', name: 'other-model' })];
    const { controller } = controllerWith(models, []);
    const body = await controller.list(fakeReq());
    expect(body.data.map((m) => m.id)).toEqual(['seedance-pro', 'other-model']);
  });

  it('the keyless dev fallback lists visibility-only (no extra restriction)', async () => {
    const models = [modelRow()];
    const { controller, gateway } = controllerWith(models, ['ignored']);
    const body = await controller.list(fakeReq({ auth: { ...AUTH, apiKeyId: null } }));
    expect(gateway.modelAllowlist).not.toHaveBeenCalled();
    expect(body.data).toHaveLength(1);
  });
});
