import {
  ArrowsClockwiseIcon,
  BrainIcon,
  CaretDownIcon,
  CaretRightIcon,
  CheckIcon,
  CopyIcon,
  SparkleIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { IconButton } from '../../../components/ui/IconButton';
import { ChatContent } from './ChatContent';
import type { ChatRow } from './types';

/** Seconds with two decimals, e.g. `3.32s`; `—` when the metric is absent. */
function secs(ms: number | null | undefined): string {
  return ms == null ? '—' : `${(ms / 1000).toFixed(2)}s`;
}

/**
 * One transcript row. A user turn is a right-aligned bubble; an assistant turn is
 * a left-aligned block with an optional collapsible reasoning disclosure, the
 * content (markdown-lite), a metrics row (延迟 / 总计 / 输入 / 输出), and copy +
 * regenerate actions. A failed turn renders an error bubble with a retry.
 */
export function ChatMessage({ row, onRegenerate }: { row: ChatRow; onRegenerate?: () => void }) {
  const { t } = useTranslation('console');

  if (row.role === 'user') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <div
          style={{
            maxWidth: '80%',
            background: 'var(--glass-bg)',
            border: '1px solid var(--panel-bd)',
            borderRadius: 'var(--r-lg)',
            padding: 'var(--s-2) var(--s-3)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            lineHeight: 1.6,
            color: 'var(--text)',
          }}
        >
          {row.content}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'flex-start' }}>
      <Avatar error={row.error} />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--s-2)',
        }}
      >
        {row.reasoning != null && row.reasoning !== '' && <Reasoning text={row.reasoning} />}

        {row.error ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 'var(--s-2)',
              color: 'var(--fail)',
              fontSize: 'var(--fs-sm)',
            }}
          >
            <WarningCircleIcon size={16} weight="fill" aria-hidden="true" />
            <span style={{ whiteSpace: 'pre-wrap' }}>{row.content}</span>
          </div>
        ) : (
          <ChatContent text={row.content} />
        )}
        {row.streaming && (
          <span aria-hidden="true" style={{ color: 'var(--muted)' }}>
            ▍
          </span>
        )}

        {!row.streaming && !row.error && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--s-3)',
              flexWrap: 'wrap',
              fontSize: 'var(--fs-caption)',
              color: 'var(--faint)',
            }}
          >
            {row.ttftMs != null && (
              <Metric label={t('playground.metrics.latency')} value={secs(row.ttftMs)} />
            )}
            {row.latencyMs != null && (
              <Metric label={t('playground.metrics.total')} value={secs(row.latencyMs)} />
            )}
            {row.usage != null && (
              <>
                <Metric label={t('playground.metrics.input')} value={String(row.usage.input)} />
                <Metric label={t('playground.metrics.output')} value={String(row.usage.output)} />
              </>
            )}
            <span style={{ display: 'inline-flex', gap: 'var(--s-1)', marginLeft: 'auto' }}>
              <CopyBtn text={row.content} />
              {onRegenerate !== undefined && (
                <IconButton
                  icon={ArrowsClockwiseIcon}
                  label={t('playground.regenerate')}
                  bare
                  size={14}
                  onClick={onRegenerate}
                />
              )}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function Avatar({ error }: { error?: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        flexShrink: 0,
        width: 28,
        height: 28,
        borderRadius: 999,
        display: 'grid',
        placeItems: 'center',
        background: 'var(--glass-bg)',
        border: '1px solid var(--panel-bd)',
        color: error === true ? 'var(--fail)' : 'var(--accent)',
      }}
    >
      <SparkleIcon size={16} weight="fill" />
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span>
      {label}{' '}
      <span className="tabular" style={{ color: 'var(--muted)' }}>
        {value}
      </span>
    </span>
  );
}

/** Collapsible chain-of-thought disclosure (default open; reasoning is shown muted). */
function Reasoning({ text }: { text: string }) {
  const { t } = useTranslation('console');
  const [open, setOpen] = useState(true);
  return (
    <div
      style={{
        borderLeft: '2px solid var(--hairline)',
        paddingLeft: 'var(--s-2)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--s-1)',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'var(--s-1)',
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          color: 'var(--muted)',
          fontSize: 'var(--fs-caption)',
        }}
      >
        <BrainIcon size={14} aria-hidden="true" />
        {t('playground.reasoning')}
        {open ? (
          <CaretDownIcon size={12} aria-hidden="true" />
        ) : (
          <CaretRightIcon size={12} aria-hidden="true" />
        )}
      </button>
      {open && (
        <div
          style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: 'var(--fs-caption)',
            color: 'var(--muted)',
            lineHeight: 1.6,
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
}

function CopyBtn({ text }: { text: string }) {
  const { t } = useTranslation('console');
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      icon={copied ? CheckIcon : CopyIcon}
      label={copied ? t('common.copied') : t('common.copy')}
      bare
      size={14}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    />
  );
}
