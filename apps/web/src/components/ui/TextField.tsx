import type { InputHTMLAttributes } from 'react';

export function TextField({ label, ...input }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
      {label}
      <input
        {...input}
        className="panel"
        style={{
          fontSize: 13,
          color: 'var(--text)',
          padding: '9px 11px',
          borderRadius: 'var(--r-sm)',
          outline: 'none',
          ...input.style,
        }}
      />
    </label>
  );
}
