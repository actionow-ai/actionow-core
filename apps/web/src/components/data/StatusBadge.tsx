export type Tone = 'ok' | 'run' | 'wait' | 'fail' | 'idle';

const TONE_COLOR: Record<Tone, string> = {
  ok: 'var(--ok)',
  run: 'var(--run)',
  wait: 'var(--wait)',
  fail: 'var(--fail)',
  idle: 'var(--idle)',
};

const STATUS_TONE: Record<string, Tone> = {
  succeeded: 'ok',
  active: 'ok',
  ready: 'ok',
  running: 'run',
  queued: 'wait',
  pending: 'wait',
  failed: 'fail',
  disabled: 'fail',
  inactive: 'fail',
  canceled: 'idle',
};

/** Map a backend status string to a palette tone. Unknown statuses fall back to `idle`. */
export function statusTone(status: string): Tone {
  return STATUS_TONE[status] ?? 'idle';
}

/**
 * A status pill. Takes a pre-resolved `tone` and a `label` already translated by
 * the page (`t('status.'+s, s)`) — it no longer renders raw English enums.
 */
export function StatusBadge({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span
      style={{
        fontSize: 'var(--fs-caption)',
        fontWeight: 'var(--fw-medium)',
        padding: '3px 9px',
        borderRadius: 'var(--r-pill)',
        color: TONE_COLOR[tone],
        background: 'color-mix(in srgb, currentColor 16%, transparent)',
      }}
    >
      {label}
    </span>
  );
}
