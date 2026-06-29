import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';
import { Select } from '../../../components/ui/Select';
import { toast } from '../../../components/ui/toast';
import { qk } from '../../../lib/api/queryKeys';
import type { ConversationView } from '../../../lib/api/types';
import { useConsoleApi } from '../../../lib/api/useConsoleApi';
import { ChatComposer } from './ChatComposer';
import { ChatMessage } from './ChatMessage';
import { ChatWelcome } from './ChatWelcome';
import { ConversationPanel } from './ConversationPanel';
import type { ChatRow } from './types';
import { type ChatTurn, useChatStream } from './useChatStream';
import { usePlaygroundKey } from './usePlaygroundKey';

const uid = (): string => crypto.randomUUID();

/** The chat tool: conversation panel + a model-selectable streaming chat canvas. */
export function ChatTool() {
  const { t } = useTranslation('console');
  const api = useConsoleApi();
  const qc = useQueryClient();
  const { key, ready: keyReady, error: keyError, recover } = usePlaygroundKey();
  const { live, run, stop } = useChatStream();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [rows, setRows] = useState<ChatRow[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ConversationView | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const conversationsQuery = useQuery({
    queryKey: qk.conversations(),
    queryFn: () => api.listConversations({ limit: 100 }),
  });
  const conversations = conversationsQuery.data?.rows ?? [];

  const modelsQuery = useQuery({
    queryKey: ['console', 'models'],
    queryFn: () => api.listModels(),
  });
  const textModels = useMemo(
    () => (modelsQuery.data ?? []).filter((m) => m.modality === 'text'),
    [modelsQuery.data],
  );
  const modelOptions = useMemo(
    () => textModels.map((m) => ({ value: m.name, label: m.display !== '' ? m.display : m.name })),
    [textModels],
  );

  // Default the picker to the first text model once they load.
  useEffect(() => {
    if (model === '' && textModels.length > 0) setModel(textModels[0]!.name);
  }, [model, textModels]);

  // Keep the transcript pinned to the newest message while streaming/appending.
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [rows, live.content, live.reasoning]);

  /** Reset to a fresh, unsaved conversation. */
  const newChat = () => {
    if (streaming) stop();
    setActiveId(null);
    setRows([]);
    setInput('');
  };

  /** Load a saved conversation's transcript into the canvas. */
  const selectChat = async (id: string) => {
    if (streaming) stop();
    setActiveId(id);
    try {
      const detail = await api.getConversation(id);
      setRows(
        detail.messages.map((m) => ({
          id: m.id,
          role: m.role as ChatRow['role'],
          content: m.content,
          reasoning: m.reasoning,
          usage: m.usage,
          latencyMs: m.latency_ms,
          model: m.model,
        })),
      );
      if (detail.model !== null) setModel(detail.model);
    } catch {
      toast(t('playground.loadFailed'), 'error');
    }
  };

  /** Best-effort transcript persistence (never blocks the UI on a save failure). */
  const persist = async (
    convId: string,
    body: Parameters<typeof api.appendMessage>[1],
  ): Promise<void> => {
    try {
      await api.appendMessage(convId, body);
    } catch {
      toast(t('playground.saveFailed'), 'error');
    }
  };

  /** Stream one assistant turn over `turns`, persisting it to `convId` on completion. */
  const runAssistant = async (
    convId: string,
    turns: ChatTurn[],
    activeKey: string,
  ): Promise<void> => {
    setStreaming(true);
    let outcome = await run({ key: activeKey, model, messages: turns });

    // A 401 means the cached key was revoked — re-mint once and retry.
    if (outcome.kind === 'error' && outcome.unauthorized) {
      const fresh = await recover();
      if (fresh !== null) outcome = await run({ key: fresh, model, messages: turns });
    }
    setStreaming(false);

    if (outcome.kind === 'done') {
      const assistant: ChatRow = {
        id: uid(),
        role: 'assistant',
        content: outcome.content,
        reasoning: outcome.reasoning !== '' ? outcome.reasoning : null,
        usage: outcome.usage,
        ttftMs: outcome.ttftMs,
        latencyMs: outcome.totalMs,
        model,
      };
      setRows((prev) => [...prev, assistant]);
      await persist(convId, {
        role: 'assistant',
        content: assistant.content,
        reasoning: assistant.reasoning,
        usage: assistant.usage,
        latency_ms: assistant.latencyMs,
        model,
      });
      await qc.invalidateQueries({ queryKey: qk.conversations() });
    } else if (outcome.kind === 'aborted') {
      if (outcome.content !== '' || outcome.reasoning !== '') {
        const partial: ChatRow = {
          id: uid(),
          role: 'assistant',
          content: outcome.content,
          reasoning: outcome.reasoning !== '' ? outcome.reasoning : null,
          model,
        };
        setRows((prev) => [...prev, partial]);
        await persist(convId, { role: 'assistant', content: partial.content, model });
      }
    } else {
      setRows((prev) => [
        ...prev,
        { id: uid(), role: 'assistant', content: outcome.message, error: true },
      ]);
      toast(t('playground.runFailed'), 'error');
    }
  };

  /** Send a user turn — the composer input, or an explicit prompt (welcome chip). */
  const send = async (prompt?: string) => {
    const text = (prompt ?? input).trim();
    if (text === '' || streaming || !keyReady || key === null || model === '') return;
    setInput('');

    const userRow: ChatRow = { id: uid(), role: 'user', content: text };
    const priorTurns: ChatTurn[] = rows
      .filter((r) => !r.error && (r.role === 'user' || r.role === 'assistant'))
      .map((r) => ({ role: r.role, content: r.content }));
    setRows((prev) => [...prev, userRow]);

    // Lazily create the conversation on the first turn.
    let convId = activeId;
    if (convId === null) {
      try {
        const conv = await api.createConversation({ model, title: text.slice(0, 40) });
        convId = conv.id;
        setActiveId(conv.id);
        await qc.invalidateQueries({ queryKey: qk.conversations() });
      } catch {
        toast(t('playground.saveFailed'), 'error');
        // Keep going without persistence — the chat still works in-memory.
      }
    }
    if (convId !== null) await persist(convId, { role: 'user', content: text });

    await runAssistant(convId ?? '', [...priorTurns, { role: 'user', content: text }], key);
  };

  /** Re-stream the last assistant turn (drops it, replays from the prior user turn). */
  const regenerate = async () => {
    if (streaming || !keyReady || key === null || model === '') return;
    const lastAssistant = [...rows].reverse().findIndex((r) => r.role === 'assistant');
    if (lastAssistant === -1) return;
    const cut = rows.length - 1 - lastAssistant;
    const kept = rows.slice(0, cut);
    setRows(kept);
    const turns: ChatTurn[] = kept
      .filter((r) => !r.error && (r.role === 'user' || r.role === 'assistant'))
      .map((r) => ({ role: r.role, content: r.content }));
    await runAssistant(activeId ?? '', turns, key);
  };

  const rename = async (id: string, title: string) => {
    try {
      await api.updateConversation(id, { title });
      await qc.invalidateQueries({ queryKey: qk.conversations() });
    } catch {
      toast(t('playground.saveFailed'), 'error');
    }
  };

  const confirmDelete = async () => {
    if (deleteTarget === null) return;
    const { id } = deleteTarget;
    setDeleteTarget(null);
    try {
      await api.deleteConversation(id);
      await qc.invalidateQueries({ queryKey: qk.conversations() });
      if (activeId === id) newChat();
    } catch {
      toast(t('playground.deleteFailed'), 'error');
    }
  };

  const lastAssistantId = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i]!.role === 'assistant' && rows[i]!.error !== true) return rows[i]!.id;
    }
    return null;
  }, [rows]);

  const composerDisabled = !keyReady || model === '';
  const disabledReason =
    keyError !== null
      ? t('playground.keyError')
      : !keyReady
        ? t('playground.keyProvisioning')
        : model === ''
          ? t('playground.noModels')
          : undefined;

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <ConversationPanel
        conversations={conversations}
        activeId={activeId}
        loading={conversationsQuery.isLoading}
        onNew={newChat}
        onSelect={(id) => void selectChat(id)}
        onRename={(id, title) => void rename(id, title)}
        onDelete={setDeleteTarget}
      />

      <section
        style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', height: '100%' }}
      >
        {/* Top bar: the model picker. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--s-2)',
            padding: 'var(--s-2) var(--s-3)',
            borderBottom: '1px solid var(--hairline)',
          }}
        >
          <div style={{ minWidth: 220 }}>
            <Select
              value={model}
              onChange={setModel}
              options={modelOptions}
              placeholder={t('playground.selectModel')}
              ariaLabel={t('playground.selectModel')}
            />
          </div>
        </div>

        {/* Transcript. */}
        <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {rows.length === 0 && !streaming ? (
            <ChatWelcome
              state={
                modelsQuery.isLoading ? 'loading' : textModels.length === 0 ? 'noModels' : 'ready'
              }
              modelLabel={modelOptions.find((o) => o.value === model)?.label ?? model}
              onPick={(p) => void send(p)}
            />
          ) : (
            <div
              style={{
                maxWidth: 768,
                margin: '0 auto',
                padding: 'var(--s-4) var(--s-3)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--s-4)',
              }}
            >
              {rows.map((row) => (
                <ChatMessage
                  key={row.id}
                  row={row}
                  onRegenerate={
                    row.id === lastAssistantId && !streaming ? () => void regenerate() : undefined
                  }
                />
              ))}
              {streaming && (
                <ChatMessage
                  row={{
                    id: 'live',
                    role: 'assistant',
                    content: live.content,
                    reasoning: live.reasoning !== '' ? live.reasoning : null,
                    streaming: true,
                  }}
                />
              )}
            </div>
          )}
        </div>

        {keyError !== null && (
          <div
            style={{
              padding: 'var(--s-2) var(--s-3)',
              color: 'var(--fail)',
              fontSize: 'var(--fs-caption)',
              display: 'flex',
              gap: 'var(--s-2)',
              alignItems: 'center',
            }}
          >
            {t('playground.keyError')}
            <button type="button" className="btn-link" onClick={() => void recover()}>
              {t('common.retry')}
            </button>
          </div>
        )}

        <ChatComposer
          value={input}
          onChange={setInput}
          onSend={() => void send()}
          onStop={stop}
          streaming={streaming}
          disabled={composerDisabled}
          disabledReason={disabledReason}
        />
      </section>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('playground.confirmDeleteTitle')}
        message={t('playground.confirmDeleteMsg', { title: deleteTarget?.title ?? '' })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        danger
        onConfirm={() => void confirmDelete()}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}
