import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';

/**
 * A read-only value (e.g. a freshly-minted API key) in a single bordered pill
 * (the design's `.copyf`): the mono value plus an icon copy button that swaps to
 * a green check on success. `navigator.clipboard.writeText` can reject —
 * insecure origin, denied permission — so the write is guarded and surfaces a
 * `failedLabel` instead of failing silently. The reset timer is cleared on
 * unmount (no setState after unmount), and a visually-hidden `aria-live` region
 * announces the result.
 */
export function CopyField({
  value,
  copyLabel,
  copiedLabel,
  failedLabel,
}: {
  value: string;
  copyLabel: string;
  copiedLabel: string;
  /** Shown (and announced) when the clipboard write is denied. Defaults to `copyLabel`. */
  failedLabel?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1800);
  };

  const failed = failedLabel ?? copyLabel;
  const label = state === 'copied' ? copiedLabel : state === 'failed' ? failed : copyLabel;
  const announce = state === 'copied' ? copiedLabel : state === 'failed' ? failed : '';
  const copied = state === 'copied';

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--s-3)',
        maxWidth: '100%',
        minHeight: 42,
        padding: '8px 8px 8px 14px',
        background: 'var(--glass-bg)',
        border: '1px solid var(--panel-bd)',
        borderRadius: 'var(--r-sm)',
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: 'ui-monospace, Menlo, monospace',
          fontSize: 'var(--fs-sm)',
          color: 'var(--text)',
          overflow: 'auto',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </span>
      <button
        type="button"
        className="row-action hit-slop"
        aria-label={label}
        title={label}
        onClick={() => void copy()}
        // Inline color wins over `.row-action:hover` so the success check stays green.
        style={copied ? { color: 'var(--ok)' } : undefined}
      >
        {copied ? (
          <CheckIcon size={15} weight="bold" aria-hidden="true" />
        ) : (
          <CopyIcon size={15} weight="bold" aria-hidden="true" />
        )}
      </button>
      <span
        aria-live="polite"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {announce}
      </span>
    </div>
  );
}
