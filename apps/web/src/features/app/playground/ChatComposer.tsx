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
          <button
            type="button"
            onClick={onSend}
            disabled={!canSend}
            aria-label={t('playground.send')}
            style={{
              width: 38,
              height: 38,
              flexShrink: 0,
              borderRadius: 'var(--r-md)',
              border: 'none',
              display: 'grid',
              placeItems: 'center',
              cursor: canSend ? 'pointer' : 'default',
              background: 'var(--grad-accent)',
              color: 'var(--bg)',
              opacity: canSend ? 1 : 0.4,
              transition:
                'opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out)',
            }}
            onMouseDown={(e) => {
              if (canSend) e.currentTarget.style.transform = 'scale(0.94)';
            }}
            onMouseUp={(e) => {
              e.currentTarget.style.transform = 'scale(1)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'scale(1)';
            }}
          >
            <ArrowUpIcon size={18} weight="bold" />
          </button>
        )}
      </div>
    </div>
  );
}
