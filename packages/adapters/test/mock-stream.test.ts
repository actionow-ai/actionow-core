import type { AdapterContext, StreamEvent, SubmitInput } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { createMockStream } from '../src/mock-stream.js';

/** A context whose http throws if touched — proving the adapter is pure. */
const noNetworkCtx: AdapterContext = {
  providerType: 'mock-stream',
  http: {
    request: () => Promise.reject(new Error('no network in mock-stream')),
    stream: () => Promise.reject(new Error('no network in mock-stream')),
  },
};

const baseInput = (inputs: Record<string, unknown> = {}): SubmitInput => ({
  resourceId: 'model:mock/stream',
  modality: 'text',
  inputs,
  execMode: 'stream',
  ctx: noNetworkCtx,
});

async function drain(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of it) {
    out.push(ev);
  }
  return out;
}

/** Invoke the adapter's stream() with a no-network context, guarding undefined. */
function streamEvents(): AsyncIterable<StreamEvent> {
  const events = createMockStream().stream?.(baseInput(), noNetworkCtx);
  if (events === undefined) {
    throw new Error('mock-stream adapter has no stream()');
  }
  return events;
}

describe('mock-stream adapter', () => {
  it('exposes the mock-stream provider type', () => {
    expect(createMockStream().providerType).toBe('mock-stream');
  });

  it('streams deterministic deltas then usage + done (no network)', async () => {
    const events = await drain(streamEvents());
    expect(events).toEqual([
      { kind: 'delta', text: 'hel' },
      { kind: 'delta', text: 'lo' },
      { kind: 'usage', usage: { input_tokens: 10, output_tokens: 5 } },
      { kind: 'done', usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
  });

  it('is deterministic across repeated runs', async () => {
    const first = await drain(streamEvents());
    const second = await drain(streamEvents());
    expect(first).toEqual(second);
  });

  it('cleans up when the consumer stops early (only first delta consumed)', async () => {
    const seen: StreamEvent[] = [];
    for await (const ev of streamEvents()) {
      seen.push(ev);
      break;
    }
    expect(seen).toEqual([{ kind: 'delta', text: 'hel' }]);
  });

  it('submit returns the concatenated text + usage for the blocking path', async () => {
    const adapter = createMockStream();
    const result = await adapter.submit(baseInput());
    expect(result.kind).toBe('sync');
    if (result.kind === 'sync') {
      expect(result.output.text).toBe('hello');
      expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    }
  });

  it('extractUsage normalizes an input/output token block', () => {
    expect(
      createMockStream().extractUsage({ usage: { input_tokens: 3, output_tokens: 4 } }),
    ).toEqual({ input_tokens: 3, output_tokens: 4 });
  });

  it('extractUsage defaults missing counts to zero', () => {
    expect(createMockStream().extractUsage({})).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it('mapError returns an upstream_error UnifiedError', () => {
    const err = createMockStream().mapError({ message: 'boom' });
    expect(err.code).toBe('upstream_error');
    expect(err.upstream?.provider).toBe('mock-stream');
  });
});
