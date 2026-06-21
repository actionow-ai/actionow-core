import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { RelayTraceView } from '../../lib/api/types';
import type { PillTone } from '../ui/Pill';
import { Pill } from '../ui/Pill';

/** Map an upstream HTTP status to a pill tone by class (2xx ok, 4xx caution, 5xx fail). */
export function httpTone(status: number | null): PillTone {
  if (status === null) return 'idle';
  if (status >= 500) return 'fail';
  if (status >= 400) return 'wait';
  if (status >= 200 && status < 300) return 'ok';
  return 'idle';
}

/** Pretty-print a JSON body; pass non-JSON through; empty/null → ''. */
export function prettyBody(body: string | null): string {
  if (body === null || body === '') return '';
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
      <h3
        style={{
          margin: 0,
          fontSize: 'var(--fs-caption)',
          fontWeight: 'var(--fw-medium)',
          letterSpacing: '.06em',
          textTransform: 'uppercase',
          color: 'var(--faint)',
        }}
      >
        {label}
      </h3>
      {children}
    </section>
  );
}

function CodeBlock({ text }: { text: string }) {
  return (
    <pre
      className="mono panel"
      style={{
        margin: 0,
        padding: 'var(--s-3)',
        borderRadius: 'var(--r-sm)',
        fontSize: 'var(--fs-caption)',
        lineHeight: 1.5,
        color: 'var(--text)',
        maxHeight: 280,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {text}
    </pre>
  );
}

/**
 * The trace-viewer primitive: a structured inspector for one upstream relay
 * audit trace. Headers are already token-redacted server-side; bodies may be
 * truncated (a flag is shown). JSON bodies are pretty-printed. Rendered inside a
 * Drawer by the relay-traces page, but standalone-usable.
 */
export function TraceViewer({ trace }: { trace: RelayTraceView }) {
  const { t } = useTranslation('console');

  const statusPill =
    trace.response_status !== null ? (
      <Pill tone={httpTone(trace.response_status)}>{trace.response_status}</Pill>
    ) : trace.error !== null ? (
      <Pill tone="fail">{t('relayTraces.viewer.err')}</Pill>
    ) : (
      <Pill tone="idle">—</Pill>
    );

  const meta: { label: string; value: string | null }[] = [
    { label: t('relayTraces.viewer.tenant'), value: trace.tenant_id },
    { label: t('relayTraces.viewer.job'), value: trace.job_id },
    { label: t('relayTraces.viewer.channel'), value: trace.channel_id },
    { label: t('relayTraces.viewer.provider'), value: trace.provider_type },
  ];

  const reqBody = prettyBody(trace.request_body);
  const resBody = prettyBody(trace.response_body);
  const headerEntries = Object.entries(trace.request_headers ?? {});

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', flexWrap: 'wrap' }}>
        <span className="mono" style={{ fontWeight: 'var(--fw-medium)', fontSize: 'var(--fs-sm)' }}>
          {trace.method}
        </span>
        {statusPill}
        {trace.latency_ms !== null && (
          <span className="tabular" style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
            {trace.latency_ms} ms
          </span>
        )}
        {trace.is_stream && <Pill tone="run">{t('relayTraces.viewer.stream')}</Pill>}
        {trace.truncated && <Pill tone="wait">{t('relayTraces.viewer.truncated')}</Pill>}
        <span style={{ marginLeft: 'auto', fontSize: 'var(--fs-caption)', color: 'var(--faint)' }}>
          {new Date(trace.created_at).toLocaleString()}
        </span>
      </div>

      <Section label={t('relayTraces.viewer.url')}>
        <code
          className="mono"
          style={{ fontSize: 'var(--fs-sm)', wordBreak: 'break-all', color: 'var(--text)' }}
        >
          {trace.url}
        </code>
      </Section>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-4)' }}>
        {meta
          .filter((m) => m.value !== null && m.value !== '')
          .map((m) => (
            <div key={m.label} style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 'var(--fs-caption)',
                  textTransform: 'uppercase',
                  letterSpacing: '.06em',
                  color: 'var(--faint)',
                }}
              >
                {m.label}
              </div>
              <div
                className="mono"
                style={{ fontSize: 'var(--fs-sm)', marginTop: 2, wordBreak: 'break-all' }}
              >
                {m.value}
              </div>
            </div>
          ))}
      </div>

      {trace.error !== null && (
        <Section label={t('relayTraces.viewer.error')}>
          <div
            className="mono"
            style={{
              fontSize: 'var(--fs-caption)',
              color: 'var(--fail)',
              background: 'color-mix(in srgb, var(--fail) 12%, transparent)',
              border: '1px solid color-mix(in srgb, var(--fail) 30%, transparent)',
              borderRadius: 'var(--r-sm)',
              padding: 'var(--s-3)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {trace.error}
          </div>
        </Section>
      )}

      {headerEntries.length > 0 && (
        <Section label={t('relayTraces.viewer.reqHeaders')}>
          <div
            className="panel"
            style={{
              borderRadius: 'var(--r-sm)',
              padding: 'var(--s-3)',
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              gap: 'var(--s-1) var(--s-3)',
            }}
          >
            {headerEntries.map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <span
                  className="mono"
                  style={{
                    fontSize: 'var(--fs-caption)',
                    color: 'var(--muted)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {k}
                </span>
                <span
                  className="mono"
                  style={{ fontSize: 'var(--fs-caption)', wordBreak: 'break-all' }}
                >
                  {v}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {reqBody !== '' && (
        <Section label={t('relayTraces.viewer.reqBody')}>
          <CodeBlock text={reqBody} />
        </Section>
      )}
      {resBody !== '' && (
        <Section label={t('relayTraces.viewer.resBody')}>
          <CodeBlock text={resBody} />
        </Section>
      )}
    </div>
  );
}
