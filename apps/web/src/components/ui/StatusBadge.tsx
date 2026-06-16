export function StatusBadge({ status }: { status: string }) {
  const active = status === 'active';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        fontWeight: 600,
        padding: '2px 9px',
        borderRadius: 'var(--r-pill)',
        whiteSpace: 'nowrap',
        color: active ? 'var(--ink)' : 'var(--muted)',
        background: active ? 'linear-gradient(135deg, var(--accent), var(--accent-2))' : 'var(--panel-bg)',
        border: active ? 'none' : '1px solid var(--panel-bd)',
      }}
    >
      {status}
    </span>
  );
}
