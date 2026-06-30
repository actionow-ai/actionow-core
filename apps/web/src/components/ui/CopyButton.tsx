import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { IconButton } from './IconButton';

/** Icon-only click-to-copy button (Copy → Check). i18n-defaulted, with a failure state
 *  and timer cleanup. For a value-pill copy field use CopyField instead. */
export function CopyButton({
  value,
  size = 14,
  bare = true,
  label,
  copiedLabel,
  failedLabel,
}: {
  value: string;
  size?: number;
  bare?: boolean;
  label?: string;
  copiedLabel?: string;
  failedLabel?: string;
}) {
  const { t } = useTranslation('console');
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onClick = () => {
    void navigator.clipboard.writeText(value).then(
      () => setState('copied'),
      () => setState('failed'),
    );
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1500);
  };

  const lbl =
    state === 'copied'
      ? (copiedLabel ?? t('common.copied'))
      : state === 'failed'
        ? (failedLabel ?? t('common.copyFailed'))
        : (label ?? t('common.copy'));

  return (
    <IconButton
      icon={state === 'copied' ? CheckIcon : CopyIcon}
      label={lbl}
      bare={bare}
      size={size}
      onClick={onClick}
    />
  );
}
