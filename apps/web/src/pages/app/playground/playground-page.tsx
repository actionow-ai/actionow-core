import type {
  AppendMessageBody,
  ConsoleModelView,
  ConversationDetailView,
  ConversationView,
  CreateConversationBody,
  MessageView,
  UpdateConversationBody,
} from '@actionow/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  KeyRound,
  MessagesSquare,
  Pencil,
  Plus,
  RotateCw,
  Send,
  Settings2,
  Square,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiFetch, type PageOf, toApiStateError } from '@/api/client';
import { useCursorQuery } from '@/api/hooks';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { CopyButton } from '@/components/common/copy-button';
import { FormField } from '@/components/common/form-field';
import { LoadMore } from '@/components/common/load-more';
import { useConsoleMe } from '@/components/layout/console-me';
import { ApiErrorNotice, ResourceLoading } from '@/components/shell/api-state';
import { EmptyState, PageHeader, PageTransition } from '@/components/shell/page';
import { Button } from '@/components/ui/components/buttons/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/components/radix/dialog';
import { Card, Skeleton } from '@/components/ui/data-display';
import { Input, Textarea } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

import {
  ChatCallError,
  chatComplete,
  type ChatOutcome,
  chatStream,
  type ChatTurn,
  isAbortError,
} from './chat-api';
import { type PlaygroundKey, usePlaygroundKey } from './use-playground-key';

const LIST_KEY = ['console', 'conversations'] as const;
const detailKey = (id: string | null) => ['console', 'conversation-detail', id] as const;

interface ThreadMessageItem {
  kind: 'message';
  key: string;
  role: string;
  content: string;
  model: string | null;
  latencyMs: number | null;
  usage: { input: number; output: number } | null;
}

interface ThreadErrorItem {
  kind: 'error';
  key: string;
  text: string;
}

type ThreadItem = ThreadMessageItem | ThreadErrorItem;

let itemCounter = 0;
function nextItemKey(): string {
  itemCounter += 1;
  return `local-${String(itemCounter)}`;
}

function toThreadItem(message: MessageView): ThreadMessageItem {
  return {
    kind: 'message',
    key: message.id,
    role: message.role,
    content: message.content,
    model: message.model,
    latencyMs: message.latency_ms,
    usage: message.usage,
  };
}

export function PlaygroundPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const me = useConsoleMe();
  const isAdmin = me.data?.tenant_role === 'admin';

  const {
    cachedKey,
    pastedKey,
    setPastedKey,
    rememberPasted,
    setRememberPasted,
    ensureKey,
    rotateKey,
  } = usePlaygroundKey();

  const conversations = useCursorQuery<ConversationView>({
    key: LIST_KEY,
    path: '/console/conversations',
    limit: 30,
  });

  const modelsQuery = useQuery({
    queryKey: ['console', 'models'],
    queryFn: () => apiFetch<PageOf<ConsoleModelView>>('/console/models'),
  });
  const chatModels = useMemo(
    () => (modelsQuery.data?.data ?? []).filter((model) => model.modality === 'text'),
    [modelsQuery.data],
  );

  const [activeId, setActiveId] = useState<string | null>(null);
  const [items, setItems] = useState<ThreadItem[]>([]);
  const [input, setInput] = useState('');
  const [model, setModel] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [streamEnabled, setStreamEnabled] = useState(true);
  const [sending, setSending] = useState(false);
  const [streamText, setStreamText] = useState<string | null>(null);
  const [minted, setMinted] = useState<PlaygroundKey | null>(null);
  const [regenPending, setRegenPending] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ConversationView | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const streamTextRef = useRef('');
  const threadRef = useRef<HTMLDivElement | null>(null);
  /** Stamp of the last server transcript applied to `items` (dedupes re-applies). */
  const appliedStampRef = useRef(0);
  /** `items` holds local turns the server may not have yet — do not clobber from cache. */
  const dirtyRef = useRef(false);
  /** After persistence, only a server transcript containing this row id may replace `items`. */
  const lastPersistedIdRef = useRef<string | null>(null);

  const detail = useQuery({
    queryKey: detailKey(activeId),
    queryFn: ({ signal }) =>
      apiFetch<ConversationDetailView>(`/console/conversations/${activeId ?? ''}`, { signal }),
    enabled: activeId !== null,
    refetchOnWindowFocus: false,
  });

  // Apply the server transcript to the thread. Skipped while a send is in
  // flight, and — once local unsaved turns exist — until the server copy
  // provably contains the last persisted row (protects against stale refetches
  // wiping streamed turns).
  useEffect(() => {
    if (sending) return;
    const data = detail.data;
    if (data?.id !== activeId) return;
    if (dirtyRef.current) {
      const anchor = lastPersistedIdRef.current;
      if (anchor === null || !data.messages.some((message) => message.id === anchor)) return;
      dirtyRef.current = false;
    }
    if (appliedStampRef.current === detail.dataUpdatedAt) return;
    appliedStampRef.current = detail.dataUpdatedAt;
    setItems(data.messages.map(toThreadItem));
    if (data.model !== null && chatModels.some((m) => m.name === data.model)) {
      setModel(data.model);
    }
  }, [detail.data, detail.dataUpdatedAt, activeId, sending, chatModels]);

  // Default the picker to the first chat-capable model.
  useEffect(() => {
    if (model !== '') return;
    const first = chatModels[0];
    if (first !== undefined) setModel(first.name);
  }, [chatModels, model]);

  // Keep the thread pinned to the bottom as content streams in.
  useEffect(() => {
    const el = threadRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [items, streamText]);

  const pushNote = (text: string) => {
    setItems((prev) => [...prev, { kind: 'error', key: nextItemKey(), text }]);
  };

  const resetThread = () => {
    if (sending) return;
    setActiveId(null);
    setItems([]);
    appliedStampRef.current = 0;
    dirtyRef.current = false;
    lastPersistedIdRef.current = null;
  };

  const selectConversation = (id: string) => {
    if (sending || id === activeId) return;
    setActiveId(id);
    setItems([]);
    appliedStampRef.current = 0;
    dirtyRef.current = false;
    lastPersistedIdRef.current = null;
  };

  const rename = useMutation({
    mutationFn: (vars: { id: string; title: string }) =>
      apiFetch<ConversationView>(`/console/conversations/${vars.id}`, {
        method: 'PATCH',
        body: { title: vars.title } satisfies UpdateConversationBody,
      }),
    onSuccess: () => {
      setRenameTarget(null);
      void queryClient.invalidateQueries({ queryKey: LIST_KEY });
    },
  });

  const removeConversation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<unknown>(`/console/conversations/${id}`, { method: 'DELETE' }),
    onSuccess: (_result, id) => {
      setDeleteTarget(null);
      if (id === activeId) resetThread();
      void queryClient.invalidateQueries({ queryKey: LIST_KEY });
    },
  });

  function noteFor(error: unknown): string {
    if (error instanceof ChatCallError) {
      const label =
        error.status === 401
          ? t('playground.errorUnauthorized')
          : error.status === 402
            ? t('playground.errorInsufficientCredits')
            : error.status === 429
              ? t('playground.errorRateLimited')
              : error.code === 'stream_truncated'
                ? t('playground.errorStreamTruncated')
                : t('playground.errorGeneric');
      return error.message === '' ? label : `${label} — ${error.message}`;
    }
    return `${t('playground.errorGeneric')} — ${toApiStateError(error).message}`;
  }

  async function handleRegenerate(): Promise<void> {
    if (regenPending) return;
    setRegenPending(true);
    try {
      const rotated = await rotateKey();
      setMinted(rotated);
    } catch (error) {
      pushNote(`${t('playground.errorMintFailed')} — ${toApiStateError(error).message}`);
    } finally {
      setRegenPending(false);
    }
  }

  async function handleSend(): Promise<void> {
    if (sending) return;
    const prompt = input.trim();
    if (prompt === '' || model === '') return;

    // 1. Resolve the data-plane key (mint lazily for admins, paste for members).
    let apiKey: string;
    if (isAdmin) {
      try {
        const ensured = await ensureKey();
        apiKey = ensured.key.plaintext;
        if (ensured.mintedNow) setMinted(ensured.key);
      } catch (error) {
        pushNote(`${t('playground.errorMintFailed')} — ${toApiStateError(error).message}`);
        return;
      }
    } else {
      apiKey = pastedKey.trim();
      if (apiKey === '') {
        pushNote(t('playground.keyRequiredMember'));
        return;
      }
    }

    // 2. Build the request history BEFORE the optimistic append.
    const requestMessages: ChatTurn[] = [];
    const system = systemPrompt.trim();
    if (system !== '') requestMessages.push({ role: 'system', content: system });
    for (const item of items) {
      if (item.kind !== 'message') continue;
      if (item.role === 'user' || item.role === 'assistant' || item.role === 'system') {
        requestMessages.push({ role: item.role, content: item.content });
      }
    }
    requestMessages.push({ role: 'user', content: prompt });

    setSending(true);
    setInput('');
    lastPersistedIdRef.current = null;

    // 3. Lazily create the conversation on the first send.
    let conversationId = activeId;
    if (conversationId === null) {
      try {
        const created = await apiFetch<ConversationView>('/console/conversations', {
          method: 'POST',
          body: { title: prompt.slice(0, 30), model } satisfies CreateConversationBody,
        });
        conversationId = created.id;
        setActiveId(created.id);
        void queryClient.invalidateQueries({ queryKey: LIST_KEY });
      } catch (error) {
        pushNote(
          `${t('playground.errorCreateConversationFailed')} — ${toApiStateError(error).message}`,
        );
        setSending(false);
        setInput(prompt);
        return;
      }
    }

    dirtyRef.current = true;
    setItems((prev) => [
      ...prev,
      {
        kind: 'message',
        key: nextItemKey(),
        role: 'user',
        content: prompt,
        model: null,
        latencyMs: null,
        usage: null,
      },
    ]);

    // 4. Run the /v1 call (streaming by default), with one admin 401 self-heal.
    const controller = new AbortController();
    abortRef.current = controller;
    streamTextRef.current = '';
    setStreamText('');
    const startedAt = performance.now();

    const run = (key: string): Promise<ChatOutcome> =>
      streamEnabled
        ? chatStream({
            apiKey: key,
            model,
            messages: requestMessages,
            signal: controller.signal,
            onDelta: (text) => {
              streamTextRef.current = text;
              setStreamText(text);
            },
          })
        : chatComplete({
            apiKey: key,
            model,
            messages: requestMessages,
            signal: controller.signal,
          });

    let outcome: ChatOutcome | null = null;
    let aborted = false;
    try {
      try {
        outcome = await run(apiKey);
      } catch (error) {
        if (error instanceof ChatCallError && error.status === 401 && isAdmin) {
          let healed: PlaygroundKey | null = null;
          try {
            healed = await rotateKey();
          } catch {
            healed = null;
          }
          if (healed === null) throw error;
          setMinted(healed);
          streamTextRef.current = '';
          setStreamText('');
          outcome = await run(healed.plaintext);
        } else {
          throw error;
        }
      }
    } catch (error) {
      if (isAbortError(error)) aborted = true;
      else pushNote(noteFor(error));
    }
    abortRef.current = null;

    const latencyMs = Math.round(performance.now() - startedAt);
    let finished: ThreadMessageItem | null = null;
    if (outcome !== null) {
      finished = {
        kind: 'message',
        key: nextItemKey(),
        role: 'assistant',
        content: outcome.content,
        model: outcome.model ?? model,
        latencyMs,
        usage:
          outcome.usage === null
            ? null
            : { input: outcome.usage.prompt_tokens, output: outcome.usage.completion_tokens },
      };
    } else if (aborted && streamTextRef.current !== '') {
      // User stop: keep the partial transcript (no usage frame was received).
      finished = {
        kind: 'message',
        key: nextItemKey(),
        role: 'assistant',
        content: streamTextRef.current,
        model,
        latencyMs,
        usage: null,
      };
    }
    setStreamText(null);

    // 5. Persist the exchange (storage-only): user turn, then assistant turn.
    const assistant = finished;
    if (assistant !== null) {
      setItems((prev) => [...prev, assistant]);
      try {
        await apiFetch<MessageView>(`/console/conversations/${conversationId}/messages`, {
          method: 'POST',
          body: { role: 'user', content: prompt } satisfies AppendMessageBody,
        });
        const persisted = await apiFetch<MessageView>(
          `/console/conversations/${conversationId}/messages`,
          {
            method: 'POST',
            body: {
              role: 'assistant',
              content: assistant.content,
              usage: assistant.usage,
              latency_ms: assistant.latencyMs,
              model: assistant.model,
            } satisfies AppendMessageBody,
          },
        );
        lastPersistedIdRef.current = persisted.id;
        void queryClient.invalidateQueries({ queryKey: detailKey(conversationId) });
        void queryClient.invalidateQueries({ queryKey: LIST_KEY });
      } catch (error) {
        pushNote(`${t('playground.persistFailed')} — ${toApiStateError(error).message}`);
      }
    }
    setSending(false);
  }

  function assistantMeta(item: ThreadMessageItem): string {
    const parts: string[] = [];
    if (item.model !== null && item.model !== '') parts.push(item.model);
    if (item.latencyMs !== null) parts.push(`${String(item.latencyMs)} ms`);
    if (item.usage !== null) {
      parts.push(
        t('playground.metaTokens', { input: item.usage.input, output: item.usage.output }),
      );
    }
    return parts.join(' · ');
  }

  const renderItem = (item: ThreadItem) => {
    if (item.kind === 'error') {
      return (
        <div
          key={item.key}
          role="alert"
          className="rounded-lg bg-danger/10 px-3 py-2 text-xs leading-relaxed text-danger"
        >
          {item.text}
        </div>
      );
    }
    if (item.role === 'user') {
      return (
        <div key={item.key} className="flex justify-end">
          <div className="max-w-[85%] whitespace-pre-wrap rounded-xl bg-surface-subtle px-4 py-2.5 text-sm leading-relaxed">
            {item.content}
          </div>
        </div>
      );
    }
    if (item.role === 'system') {
      return (
        <div
          key={item.key}
          className="rounded-lg bg-surface-subtle/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
        >
          <p className="font-medium">{t('playground.roleSystem')}</p>
          <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap">{item.content}</p>
        </div>
      );
    }
    const meta = assistantMeta(item);
    return (
      <div key={item.key} className="max-w-[85%] space-y-1.5">
        <div className="whitespace-pre-wrap text-sm leading-relaxed">{item.content}</div>
        {meta !== '' ? (
          <p className="font-mono text-xs tabular-nums text-muted-foreground">{meta}</p>
        ) : null}
      </div>
    );
  };

  const keyPanel = me.isLoading ? (
    <Skeleton className="h-8 w-64" />
  ) : isAdmin ? (
    <>
      <KeyRound className="size-4 shrink-0 text-muted-foreground" />
      <span className="text-sm font-medium">{t('playground.keyLabel')}</span>
      {cachedKey !== null ? (
        <>
          <code className="font-mono text-sm text-muted-foreground">
            {cachedKey.id.slice(0, 8)}
          </code>
          <Button
            variant="outline"
            size="sm"
            disabled={sending || regenPending}
            onClick={() => void handleRegenerate()}
          >
            <RotateCw />
            {regenPending ? t('common.loading') : t('playground.regenerate')}
          </Button>
        </>
      ) : (
        <span className="text-sm text-muted-foreground">{t('playground.keyAutoHint')}</span>
      )}
    </>
  ) : (
    <>
      <KeyRound className="size-4 shrink-0 text-muted-foreground" />
      <span className="text-sm font-medium">{t('playground.keyLabel')}</span>
      <Input
        type="password"
        autoComplete="off"
        value={pastedKey}
        onChange={(event) => setPastedKey(event.target.value)}
        placeholder={t('playground.keyPastePlaceholder')}
        aria-label={t('playground.keyLabel')}
        className="h-8 w-64 max-w-full font-mono text-xs"
      />
      <Button
        variant={rememberPasted ? 'secondary' : 'outline'}
        size="sm"
        aria-pressed={rememberPasted}
        onClick={() => setRememberPasted(!rememberPasted)}
      >
        {t('playground.rememberKey')}
      </Button>
      <span className="text-xs text-muted-foreground">{t('playground.keyMemberHint')}</span>
    </>
  );

  return (
    <PageTransition>
      <PageHeader title={t('playground.title')} description={t('playground.description')} />

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <Card className="p-3 lg:w-72 lg:shrink-0">
          <Button className="w-full" disabled={sending} onClick={resetThread}>
            <Plus />
            {t('playground.newConversation')}
          </Button>
          <div className="mt-3">
            {conversations.isLoading ? (
              <ResourceLoading rows={3} />
            ) : conversations.isError ? (
              <ApiErrorNotice
                error={toApiStateError(conversations.error)}
                onRetry={() => void conversations.refetch()}
              />
            ) : conversations.rows.length === 0 ? (
              <EmptyState
                icon={MessagesSquare}
                title={t('playground.conversationsEmpty')}
                description={t('playground.conversationsEmptyDescription')}
              />
            ) : (
              <>
                <div className="space-y-1">
                  {conversations.rows.map((conversation) => (
                    <div
                      key={conversation.id}
                      className={cn(
                        'group flex items-center gap-1 rounded-xl px-1.5 py-1 transition-colors',
                        activeId === conversation.id
                          ? 'bg-surface-subtle'
                          : 'hover:bg-surface-subtle/60',
                      )}
                    >
                      <Button
                        variant="ghost"
                        disabled={sending}
                        onClick={() => selectConversation(conversation.id)}
                        className="h-auto min-w-0 flex-1 flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 hover:bg-transparent"
                      >
                        <span className="w-full truncate text-left text-sm font-normal">
                          {conversation.title}
                        </span>
                        {conversation.model !== null ? (
                          <span className="w-full truncate text-left font-mono text-xs text-muted-foreground">
                            {conversation.model}
                          </span>
                        ) : null}
                      </Button>
                      <div className="flex shrink-0 items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('playground.rename')}
                          disabled={sending}
                          onClick={() => {
                            setRenameTarget(conversation);
                            setRenameValue(conversation.title);
                          }}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('common.delete')}
                          disabled={sending}
                          onClick={() => setDeleteTarget(conversation.id)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="px-1.5">
                  <LoadMore
                    count={conversations.rows.length}
                    hasMore={conversations.hasNextPage}
                    loading={conversations.isFetchingNextPage}
                    onLoadMore={() => void conversations.fetchNextPage()}
                  />
                </div>
              </>
            )}
          </div>
        </Card>

        <Card className="flex min-w-0 flex-1 flex-col divide-y divide-border/60">
          <div className="space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={model} onValueChange={setModel} disabled={sending}>
                <SelectTrigger className="w-64 max-w-full">
                  <SelectValue placeholder={t('playground.modelPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {chatModels.map((item) => (
                    <SelectItem key={item.name} value={item.name}>
                      {item.display}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!modelsQuery.isLoading && !modelsQuery.isError && chatModels.length === 0 ? (
                <span className="text-sm text-muted-foreground">{t('playground.modelsEmpty')}</span>
              ) : null}
              <Button
                variant={showSystem ? 'secondary' : 'outline'}
                size="sm"
                aria-pressed={showSystem}
                onClick={() => setShowSystem((value) => !value)}
              >
                <Settings2 />
                {t('playground.systemPrompt')}
              </Button>
              <Button
                variant={streamEnabled ? 'secondary' : 'outline'}
                size="sm"
                aria-pressed={streamEnabled}
                disabled={sending}
                onClick={() => setStreamEnabled((value) => !value)}
              >
                {streamEnabled ? t('playground.streamOn') : t('playground.streamOff')}
              </Button>
            </div>
            {modelsQuery.isError ? (
              <ApiErrorNotice
                error={toApiStateError(modelsQuery.error)}
                onRetry={() => void modelsQuery.refetch()}
              />
            ) : null}
            {showSystem ? (
              <Textarea
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
                placeholder={t('playground.systemPromptPlaceholder')}
                disabled={sending}
                rows={3}
                className="min-h-16"
                aria-label={t('playground.systemPrompt')}
              />
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">{keyPanel}</div>

          <div ref={threadRef} className="h-[55vh] min-h-80 overflow-y-auto p-5">
            {activeId !== null && items.length === 0 && detail.isLoading ? (
              <ResourceLoading rows={3} />
            ) : activeId !== null && items.length === 0 && detail.isError ? (
              <ApiErrorNotice
                error={toApiStateError(detail.error)}
                onRetry={() => void detail.refetch()}
              />
            ) : items.length === 0 && !sending ? (
              <div className="flex h-full min-h-64 items-center justify-center">
                <p className="max-w-sm text-center text-sm text-muted-foreground">
                  {t('playground.threadEmpty')}
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {items.map(renderItem)}
                {sending ? (
                  <div className="max-w-[85%]">
                    <div className="whitespace-pre-wrap text-sm leading-relaxed">
                      {streamText ?? ''}
                      <span
                        className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-foreground/60 align-text-bottom"
                        aria-hidden="true"
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <div className="flex items-end gap-2 p-4">
            <Textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void handleSend();
                }
              }}
              placeholder={t('playground.composerPlaceholder')}
              disabled={sending}
              rows={2}
              className="min-h-12 flex-1 resize-none"
            />
            {sending ? (
              <Button
                variant="outline"
                size="icon"
                aria-label={t('playground.stop')}
                onClick={() => abortRef.current?.abort()}
              >
                <Square />
              </Button>
            ) : null}
            <Button
              size="icon"
              aria-label={t('playground.send')}
              disabled={sending || input.trim() === '' || model === ''}
              onClick={() => void handleSend()}
            >
              <Send />
            </Button>
          </div>
        </Card>
      </div>

      <Dialog
        open={minted !== null}
        onOpenChange={(open) => {
          if (!open) setMinted(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('playground.mintedTitle')}</DialogTitle>
            <DialogDescription>{t('playground.mintedWarning')}</DialogDescription>
          </DialogHeader>
          {minted !== null ? (
            <div className="flex items-center gap-2 rounded-xl bg-surface-subtle p-3">
              <code className="min-w-0 flex-1 break-all font-mono text-sm">{minted.plaintext}</code>
              <CopyButton value={minted.plaintext} label={t('playground.copyKey')} />
            </div>
          ) : null}
          <DialogFooter>
            <Button onClick={() => setMinted(null)}>{t('common.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRenameTarget(null);
            rename.reset();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('playground.renameTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <FormField label={t('playground.renameLabel')}>
              {(id) => (
                <Input
                  id={id}
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  maxLength={200}
                />
              )}
            </FormField>
            {rename.isError ? <ApiErrorNotice error={toApiStateError(rename.error)} /> : null}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRenameTarget(null)}
              disabled={rename.isPending}
            >
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => {
                const target = renameTarget;
                const title = renameValue.trim();
                if (target !== null && title !== '') rename.mutate({ id: target.id, title });
              }}
              disabled={rename.isPending || renameValue.trim() === ''}
            >
              {rename.isPending ? t('common.loading') : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t('playground.deleteTitle')}
        description={t('playground.deleteDescription')}
        confirmLabel={t('common.delete')}
        pending={removeConversation.isPending}
        onConfirm={() => {
          if (deleteTarget !== null) removeConversation.mutate(deleteTarget);
        }}
      />
    </PageTransition>
  );
}
