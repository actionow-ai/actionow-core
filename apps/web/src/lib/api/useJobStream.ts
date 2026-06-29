import { useEffect, useState } from 'react';

import { config } from '../../config';
import { useOptionalAuth } from '../auth/AuthProvider';

/** Job statuses that close the stream (mirrors the backend `TERMINAL` set). */
const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

export interface JobStreamState {
  /** The latest streamed status, or `null` before the first frame arrives. */
  status: string | null;
  /** `true` once a terminal frame (done/error) has been received. */
  terminal: boolean;
  /** `true` while the SSE connection is open. */
  live: boolean;
}

/**
 * Live job progress over the admin SSE stream (`GET /admin/jobs/:id/stream`, #62).
 *
 * Browsers can't attach a Bearer header to the native `EventSource`, so this
 * reads the stream with `fetch` + a `ReadableStream` reader (the admin JWT goes
 * in the request header) and parses the SSE `event:`/`data:` frames by hand. The
 * connection is torn down via `AbortController` on unmount or when `jobId`
 * changes; pass `null` to stream nothing. The stream self-closes server-side once
 * the job is terminal — the caller typically invalidates its job list then.
 */
export function useJobStream(jobId: string | null): JobStreamState {
  // Optional: stays inert (no provider → no token → no stream) in isolated renders.
  const getToken = useOptionalAuth()?.getToken;
  const [state, setState] = useState<JobStreamState>({
    status: null,
    terminal: false,
    live: false,
  });

  useEffect(() => {
    if (jobId === null || getToken === undefined) {
      setState({ status: null, terminal: false, live: false });
      return;
    }
    const token = getToken();
    if (token === null) return;

    const ctrl = new AbortController();
    let cancelled = false;

    const apply = (event: string, data: string) => {
      // We only need the status; tolerate a malformed/empty data line.
      let status: string | undefined;
      try {
        status = (JSON.parse(data) as { status?: string }).status;
      } catch {
        status = undefined;
      }
      const terminal = event === 'done' || event === 'error' || TERMINAL.has(status ?? '');
      setState((prev) => ({
        status: status ?? prev.status,
        terminal: terminal || prev.terminal,
        live: !terminal,
      }));
    };

    const run = async () => {
      const res = await fetch(`${config.apiBase}/admin/jobs/${jobId}/stream`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        signal: ctrl.signal,
      });
      if (!res.ok || res.body === null) return;
      setState({ status: null, terminal: false, live: true });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      // Each SSE frame is delimited by a blank line; comments (`:`-leading) are
      // heartbeats we skip. A frame carries one `event:` and one `data:` line.
      for (;;) {
        const { value, done } = await reader.read();
        if (done || cancelled) break;
        buffer += decoder.decode(value, { stream: true });
        let sep = buffer.indexOf('\n\n');
        while (sep !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          let event = 'message';
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data = line.slice(5).trim();
          }
          if (data !== '') apply(event, data);
          sep = buffer.indexOf('\n\n');
        }
      }
    };

    void run().catch(() => {
      // Network/abort errors end the stream silently; the job list still polls.
    });

    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [jobId, getToken]);

  return state;
}
