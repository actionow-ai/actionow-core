import type { Response } from 'express';

/**
 * Pipe a stream of pre-rendered SSE string frames to an express {@link Response}.
 *
 * Mirrors the SSE transport in `run.controller.ts`: sets the event-stream
 * headers (`Content-Type: text/event-stream`, `Cache-Control`, `Connection`,
 * `X-Accel-Buffering: no`), flushes them, and — critically — `return()`s the
 * underlying iterator on a client disconnect (`res.on('close')`) so the engine's
 * settling generator's `finally` runs (settling the job exactly once) on BOTH
 * normal completion AND disconnect. Each `frames` value is a complete SSE frame
 * (already terminated by `\n\n`) written verbatim. `res.end()`s in `finally`.
 *
 * The caller MUST have performed the engine hold (in `runChatStream`) BEFORE
 * calling this, so an `insufficient_credits`/`invalid_input` throw surfaces as a
 * real HTTP error via the `UnifiedErrorFilter` (no SSE byte written yet).
 */
export async function pipeSse(res: Response, frames: AsyncIterable<string>): Promise<void> {
  const iterator = frames[Symbol.asyncIterator]();

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Disable proxy buffering (nginx) so frames flush immediately.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // On client disconnect, end the generator → its `finally` settles the job
  // exactly once (idempotent with the normal-completion settle below). The
  // pending `iterator.next()` then resolves `done`, ending the loop.
  res.on('close', () => {
    void iterator.return?.(undefined);
  });

  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done === true || res.writableEnded) break;
      res.write(next.value);
    }
  } finally {
    // Finalize the generator even on a normal break (its `finally` settles;
    // idempotent if `res.on('close')` already returned it).
    void iterator.return?.(undefined);
    if (!res.writableEnded) res.end();
  }
}
