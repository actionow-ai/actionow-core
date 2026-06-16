const TONE: Record<string, string> = {
  succeeded: 'var(--ok)',
  active: 'var(--ok)',
  ready: 'var(--ok)',
  running: 'var(--run)',
  queued: 'var(--wait)',
  pending: 'var(--wait)',
  failed: 'var(--fail)',
  disabled: 'var(--fail)',
  canceled: 'var(--idle)',
};

export function StatusBadge({ status }: { status: string }) {
  const color = TONE[status] ?? 'var(--idle)';
  return (
    <span
      style={{
        fontSize: 'var(--fs-caption)',
        fontWeight: 600,
        padding: '3px 9px',
        borderRadius: 'var(--r-pill)',
        color,
        background: 'color-mix(in srgb, currentColor 16%, transparent)',
      }}
    >
      {status}
    </span>
  );
}
