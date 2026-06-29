import { describe, expect, it, vi } from 'vitest';

import { consumeJobStream, type JobStreamFrame } from './job-stream.js';

/** A `Response`-like object whose `body` streams the given UTF-8 string. */
function responseOf(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + 8));
      offset += 8;
    },
  });
  return { body } as unknown as Response;
}

async function collect(gen: AsyncGenerator<JobStreamFrame>): Promise<JobStreamFrame[]> {
  const out: JobStreamFrame[] = [];
  for await (const f of gen) out.push(f);
  return out;
}

describe('consumeJobStream', () => {
  it('yields snapshot → progress → done and terminates after the terminal frame', async () => {
    const wire =
      'event: snapshot\ndata: {"job_id":"j1","status":"running"}\n\n' +
      ':\n\n' + // heartbeat comment — must be skipped
      'event: progress\ndata: {"job_id":"j1","status":"running"}\n\n' +
      'event: done\ndata: {"job_id":"j1","status":"succeeded"}\n\n' +
      // A trailing frame after `done` must NOT be yielded (the generator returns).
      'event: progress\ndata: {"job_id":"j1","status":"running"}\n\n';

    const fetchImpl = vi.fn().mockResolvedValue(responseOf(wire));

    const frames = await collect(
      consumeJobStream({ baseUrl: 'https://gw.test', jobId: 'j1', token: 'k', fetch: fetchImpl }),
    );

    expect(frames.map((f) => f.event)).toEqual(['snapshot', 'progress', 'done']);
    expect((frames[2]?.data as { status: string }).status).toBe('succeeded');

    // Built the right request: GET /v1/jobs/:id/stream, SSE Accept, Bearer token.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gw.test/v1/jobs/j1/stream');
    expect(init.method).toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toBe('text/event-stream');
    expect(headers.Authorization).toBe('Bearer k');
  });

  it('terminates on a terminal error frame', async () => {
    const wire =
      'event: snapshot\ndata: {"job_id":"j1","status":"running"}\n\n' +
      'event: error\ndata: {"job_id":"j1","status":"failed"}\n\n';
    const fetchImpl = vi.fn().mockResolvedValue(responseOf(wire));

    const frames = await collect(
      consumeJobStream({ baseUrl: 'https://gw.test', jobId: 'j1', fetch: fetchImpl }),
    );

    expect(frames.map((f) => f.event)).toEqual(['snapshot', 'error']);
    // No Authorization header when no token is supplied.
    const init = (fetchImpl.mock.calls[0] as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
