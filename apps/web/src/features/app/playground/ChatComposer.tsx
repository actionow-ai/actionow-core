import { ArrowUpIcon, StopIcon } from '@phosphor-icons/react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { IconButton } from '../../../components/ui/IconButton';

/**
 * The chat input: an auto-growing textarea + a send button that becomes a stop
 * button while streaming. Enter sends; Shift+Enter inserts a newline. Disabled
 * (with a reason) until the playground key is ready / a model is selected.
 */
export function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  disabled,
  disabledReason,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  disabled: boolean;
  disabledReason?: string;
}) {
  const { t } = useTranslation('console');
  const canSend = !disabled && !streaming && value.trim() !== '';

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

  return (
    <div style={{ padding: 'var(--s-3) var(--s-4) var(--s-4)' }}>
      <div
        className="panel"
        style={{
          maxWidth: 768,
          margin: '0 auto',
          display: 'flex',
          alignItems: 'flex-end',
          gap: 'var(--s-2)',
          borderRadius: 'var(--r-lg)',
          padding: 'var(--s-2)',
          boxShadow: 'var(--shadow-lift)',
        }}
      >
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          disabled={disabled}
          placeholder={
            disabled
              ? (disabledReason ?? t('playground.composer.disabled'))
              : t('playground.composer.placeholder')
          }
          aria-label={t('playground.composer.placeholder')}
          style={{
            flex: 1,
            resize: 'none',
            border: 'none',
            background: 'transparent',
            outline: 'none',
            color: 'var(--text)',
            fontSize: 'var(--fs-sm)',
            lineHeight: 1.6,
            maxHeight: 200,
            minHeight: 24,
            padding: 'var(--s-1) var(--s-2)',
            fontFamily: 'inherit',
          }}
        />
        {streaming ? (
          <IconButton icon={StopIcon} label={t('playground.stop')} onClick={onStop} weight="fill" />
        ) : (
          <IconButton
            icon={ArrowUpIcon}
            label={t('playground.send')}
            onClick={onSend}
            active={canSend}
            weight="bold"
          />
        )}
      </div>
    </div>
  );
}
