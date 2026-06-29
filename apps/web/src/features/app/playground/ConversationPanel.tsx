import { ChatCircleIcon, PencilSimpleIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { IconButton } from '../../../components/ui/IconButton';
import { RoseLoader } from '../../../components/ui/RoseLoader';
import type { ConversationView } from '../../../lib/api/types';

/**
 * The playground's left panel: a "新对话" button + the tenant's saved
 * conversations (newest-activity first), with inline rename and a delete action
 * (the parent confirms the delete). Selecting a row loads its transcript.
 */
export function ConversationPanel({
  conversations,
  activeId,
  loading,
  onNew,
  onSelect,
  onRename,
  onDelete,
}: {
  conversations: ConversationView[];
  activeId: string | null;
  loading: boolean;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (conv: ConversationView) => void;
}) {
  const { t } = useTranslation('console');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const commitRename = (id: string) => {
    const next = draft.trim();
    if (next !== '') onRename(id, next);
    setEditingId(null);
  };

  return (
    <aside
      style={{
        width: 248,
        flexShrink: 0,
        borderRight: '1px solid var(--hairline)',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--panel-bg)',
      }}
    >
      <div style={{ padding: 'var(--s-3)' }}>
        <button
          type="button"
          onClick={onNew}
          className="btn"
          style={{
            width: '100%',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 'var(--s-1)',
          }}
        >
          <PlusIcon size={14} weight="bold" aria-hidden="true" /> {t('playground.newChat')}
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 var(--s-2) var(--s-2)' }}>
        {loading ? (
          <div style={{ display: 'grid', placeItems: 'center', padding: 'var(--s-4)' }}>
            <RoseLoader size={28} />
          </div>
        ) : conversations.length === 0 ? (
          <p
            style={{
              color: 'var(--faint)',
              fontSize: 'var(--fs-caption)',
              textAlign: 'center',
              padding: 'var(--s-3)',
            }}
          >
            {t('playground.noConversations')}
          </p>
        ) : (
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            {conversations.map((c) => {
              const active = c.id === activeId;
              return (
                <li key={c.id}>
                  {editingId === c.id ? (
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => commitRename(c.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(c.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      className="field"
                      style={{ width: '100%', fontSize: 'var(--fs-sm)' }}
                      aria-label={t('playground.rename')}
                    />
                  ) : (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--s-1)',
                        borderRadius: 'var(--r-md)',
                        padding: '6px var(--s-2)',
                        background: active ? 'var(--glass-bg)' : 'transparent',
                      }}
                    >
                      <ChatCircleIcon
                        size={14}
                        aria-hidden="true"
                        style={{ color: 'var(--faint)', flexShrink: 0 }}
                      />
                      <button
                        type="button"
                        onClick={() => onSelect(c.id)}
                        title={c.title}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          textAlign: 'left',
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          cursor: 'pointer',
                          color: active ? 'var(--text)' : 'var(--muted)',
                          fontSize: 'var(--fs-sm)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {c.title}
                      </button>
                      <span style={{ display: 'inline-flex', gap: 2 }}>
                        <IconButton
                          icon={PencilSimpleIcon}
                          label={t('playground.rename')}
                          bare
                          size={13}
                          onClick={() => {
                            setDraft(c.title);
                            setEditingId(c.id);
                          }}
                        />
                        <IconButton
                          icon={TrashIcon}
                          label={t('common.delete')}
                          bare
                          size={13}
                          onClick={() => onDelete(c)}
                        />
                      </span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
