import { describe, expect, it } from 'vitest';

import { createPluginRequestSchema, pluginManifestSchema } from './provider-plugin.js';

const validManifest = {
  id: 'openai-chat',
  label: 'OpenAI Chat',
  modalities: ['chat'],
  protocol: 'sync' as const,
  authStrategy: 'bearer' as const,
  credentialFields: [
    { key: 'api_key', label: 'API Key', type: 'password' as const, required: true },
  ],
};

describe('provider-plugin contract', () => {
  it('parses a valid manifest and defaults required=false on fields', () => {
    const m = pluginManifestSchema.parse({
      ...validManifest,
      credentialFields: [{ key: 'endpoint', label: 'Endpoint', type: 'text' }],
    });
    expect(m.id).toBe('openai-chat');
    expect(m.credentialFields[0]?.required).toBe(false);
  });

  it('rejects an unknown authStrategy', () => {
    expect(() => pluginManifestSchema.parse({ ...validManifest, authStrategy: 'wat' })).toThrow();
  });

  it('rejects an unknown protocol', () => {
    expect(() => pluginManifestSchema.parse({ ...validManifest, protocol: 'ws-stream' })).toThrow();
  });

  it('validates a create-plugin request (manifest + handler)', () => {
    const req = createPluginRequestSchema.parse({
      slug: 'openai-chat',
      label: 'OpenAI Chat',
      manifest: validManifest,
      handler: 'function mapRequest(ctx){return {method:"POST"}}',
    });
    expect(req.manifest.authStrategy).toBe('bearer');
  });
});
