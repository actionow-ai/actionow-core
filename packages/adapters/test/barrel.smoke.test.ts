import * as adapters from '@actionow/adapters';
import { describe, expect, it } from 'vitest';

describe('@actionow/adapters barrel', () => {
  it('exports the registry, routing, default registry, and all built-in adapters', () => {
    // registry
    expect(typeof adapters.AdapterRegistry).toBe('function');
    // errors
    expect(typeof adapters.AdapterError).toBe('function');
    expect(typeof adapters.httpStatusToUnified).toBe('function');
    // routing
    expect(typeof adapters.selectWeighted).toBe('function');
    expect(typeof adapters.routeWithFailover).toBe('function');
    expect(typeof adapters.isRetryableAdapterError).toBe('function');
    // default registry
    expect(typeof adapters.createDefaultRegistry).toBe('function');
    // adapters
    expect(adapters.openaiAdapter.providerType).toBe('openai');
    expect(adapters.anthropicAdapter.providerType).toBe('anthropic');
    expect(adapters.geminiAdapter.providerType).toBe('gemini');
    expect(typeof adapters.createAsyncMediaMock).toBe('function');
    expect(adapters.difyWorkflowAdapter.providerType).toBe('dify-workflow');
    expect(typeof adapters.createMockStream).toBe('function');
  });

  it('createDefaultRegistry from the barrel resolves all built-in provider_types', () => {
    const registry = adapters.createDefaultRegistry();
    for (const providerType of [
      'openai',
      'anthropic',
      'gemini',
      'async-media-mock',
      'dify-workflow',
      'mock-stream',
    ] as const) {
      expect(registry.get(providerType).providerType).toBe(providerType);
    }
  });
});
