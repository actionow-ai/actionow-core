import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wrap an async route so a rejected promise reaches Express's error path.
 * Express 4 does NOT await handlers, so without this a thrown 402/404/timeout
 * hangs the request and crashes the process (unhandledRejection).
 */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}

/**
 * Terminal error middleware — renders the unified `{ error }` envelope with the
 * right status. `core-kit` rawPost/rawGet and callWithRetry throw with
 * `.status` + `.error` attached, so a gateway 402/429/404 becomes a clean
 * response (not a hang). Must have 4 params to be recognized as an error handler.
 */
export const errorMiddleware: ErrorRequestHandler = (err, _req, res, _next) => {
  if (res.headersSent) return; // e.g. mid-stream failure — nothing to render
  const e = err as { status?: number; error?: unknown; code?: string; message?: string };
  const status = typeof e.status === 'number' ? e.status : 502;
  res.status(status).json({ error: e.error ?? { code: e.code ?? 'upstream_error', message: e.message ?? 'error' } });
};
