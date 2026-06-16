import { anthropicAdapter } from './anthropic.js';
import type { AsyncMediaMockOptions } from './async-media-mock.js';
import { createAsyncMediaMock } from './async-media-mock.js';
import { difyWorkflowAdapter } from './dify-workflow.js';
import { geminiAdapter } from './gemini.js';
import { createMockStream } from './mock-stream.js';
import { openaiAdapter } from './openai.js';
import { AdapterRegistry } from './registry.js';

/** Options for {@link createDefaultRegistry}. */
export interface DefaultRegistryOptions {
  /** Tuning for the in-process `async-media-mock` adapter. */
  asyncMedia?: AsyncMediaMockOptions;
}

/**
 * Build an {@link AdapterRegistry} pre-populated with all built-in adapters:
 * `openai`, `anthropic`, `gemini`, `async-media-mock`, `dify-workflow`, and the
 * in-process `mock-stream` (for the `stream` exec mode in tests/e2e).
 *
 * Each call returns a fresh registry whose `async-media-mock` adapter owns its
 * own in-process job map, so callers (and tests) do not share poll state.
 */
export function createDefaultRegistry(opts?: DefaultRegistryOptions): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(openaiAdapter);
  registry.register(anthropicAdapter);
  registry.register(geminiAdapter);
  registry.register(createAsyncMediaMock(opts?.asyncMedia));
  registry.register(difyWorkflowAdapter);
  registry.register(createMockStream());
  return registry;
}
