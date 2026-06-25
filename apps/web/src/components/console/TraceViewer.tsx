import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { RelayTraceView } from '../../lib/api/types';
import { CopyField } from '../data/CopyField';
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
  const { t } = useTranslation('console');
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* insecure origin / denied — leave the icon as-is */
    }
  };
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        className="row-action hit-slop"
        aria-label={copied ? t('common.copied') : t('common.copy')}
        title={copied ? t('common.copied') : t('common.copy')}
        onClick={() => void copy()}
        style={{
          position: 'absolute',
          top: 'var(--s-2)',
          right: 'var(--s-2)',
          zIndex: 1,
          ...(copied ? { color: 'var(--ok)' } : {}),
        }}
      >
        {copied ? (
          <CheckIcon size={15} weight="bold" aria-hidden="true" />
        ) : (
          <CopyIcon size={15} weight="bold" aria-hidden="true" />
        )}
      </button>
      <pre
        className="mono panel"
        style={{
          margin: 0,
          padding: 'var(--s-3)',
          paddingRight: 'var(--s-6)',
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
    </div>
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
    { label: t('relayTraces.viewer.routeTag'), value: trace.route_tag },
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
        <CopyField
          value={trace.url}
          copyLabel={t('common.copy')}
          copiedLabel={t('common.copied')}
          failedLabel={t('common.copyFailed')}
        />
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
              <div style={{ marginTop: 4 }}>
                <CopyField
                  value={m.value ?? ''}
                  copyLabel={t('common.copy')}
                  copiedLabel={t('common.copied')}
                  failedLabel={t('common.copyFailed')}
                />
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
