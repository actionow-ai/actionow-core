import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/components/buttons/button';
import { CircleCheckBigIcon } from '@/components/ui/icons/circle-check-big';
import { CopyIcon } from '@/components/ui/icons/copy';

/** Ghost icon button that copies `value` and flashes a confirmation check. */
export function CopyButton({ value, label }: { value: string; label?: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label ?? t('common.copy')}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <CircleCheckBigIcon className="text-success" /> : <CopyIcon animateOnHover />}
    </Button>
  );
}
