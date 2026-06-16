import { useState } from 'react';

import { Button } from '../ui/Button';

export function CopyField({
  value,
  copyLabel,
  copiedLabel,
}: {
  value: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 2000);
  };
  return (
    <div style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'center' }}>
      <code
        className="panel"
        style={{
          flex: 1,
          fontSize: 12,
          padding: '8px 10px',
          borderRadius: 'var(--r-sm)',
          overflow: 'auto',
          wordBreak: 'break-all',
        }}
      >
        {value}
      </code>
      <Button variant="ghost" onClick={() => void copy()}>
        {copied ? copiedLabel : copyLabel}
      </Button>
    </div>
  );
}
