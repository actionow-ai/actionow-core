import type { ReactNode } from 'react';

/** A label/value definition cell — uppercase caption label over a tabular value.
 *  The console's standard "meta" presentation (extracted from EntityCard). */
export function MetaCell({
  label,
  value,
  nowrap = true,
}: {
  label: string;
  value: ReactNode;
  nowrap?: boolean;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: 'var(--fs-caption)',
          textTransform: 'uppercase',
          letterSpacing: '.06em',
          color: 'var(--faint)',
        }}
      >
        {label}
      </div>
      <div
        className="tabular"
        style={{
          fontSize: 'var(--fs-sm)',
          color: 'var(--text)',
          marginTop: 'var(--s-0)',
          whiteSpace: nowrap ? 'nowrap' : 'normal',
        }}
      >
        {value}
      </div>
    </div>
  );
}
