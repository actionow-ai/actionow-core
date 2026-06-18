import { useEffect, useRef, useState } from 'react';

import { Button } from '../ui/Button';

/**
 * A read-only value (e.g. a freshly-minted API key) with a copy button.
 * `navigator.clipboard.writeText` can reject — insecure origin, denied
 * permission — so the write is guarded and surfaces a `failedLabel` instead of
 * failing silently. The reset timer is cleared on unmount (no setState after
 * unmount), and a visually-hidden `aria-live` region announces the result.
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
    timer.current = setTimeout(() => setState('idle'), 2000);
  };

  const failed = failedLabel ?? copyLabel;
  const label = state === 'copied' ? copiedLabel : state === 'failed' ? failed : copyLabel;
  const announce = state === 'copied' ? copiedLabel : state === 'failed' ? failed : '';

  return (
    <div style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'center' }}>
      <code
        className="panel"
        style={{
          flex: 1,
          fontSize: 'var(--fs-sm)',
          padding: 'var(--s-2) var(--s-3)',
          borderRadius: 'var(--r-sm)',
          overflow: 'auto',
          wordBreak: 'break-all',
        }}
      >
        {value}
      </code>
      <Button variant="ghost" onClick={() => void copy()}>
        {label}
      </Button>
      <span
        aria-live="polite"
        style={{ position: 'absolute', width: 1, height: 1, padding: 0, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 }}
      >
        {announce}
      </span>
    </div>
  );
}
