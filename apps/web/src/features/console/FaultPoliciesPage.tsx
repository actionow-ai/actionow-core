import { PencilSimpleIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { ChipsField } from '../../components/ui/ChipsField';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Drawer } from '../../components/ui/Drawer';
import { NumberField } from '../../components/ui/NumberField';
import { RowAction } from '../../components/ui/RowAction';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { FaultPolicyView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

/** A ms timeout for display: a value or an em-dash for "client default". */
function ms(n: number | null): string {
  return n === null ? '—' : `${String(n)}ms`;
}

/**
 * The 调用容错 (fault-tolerance policies) console page — wired to the live
 * `/admin/fault-policies` backend. A `DataTable` of named, reusable resilience
 * profiles (mode, retry count, backoff, the four timeouts, retry triggers,
 * status) with a create/edit `Drawer` and per-row delete. A policy is bound to a
 * channel in the channel editor; an unbound channel keeps the engine defaults.
 */
export function FaultPoliciesPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: qk.faultPolicies(),
    queryFn: api.listFaultPolicies,
  });

  const [editId, setEditId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [delTarget, setDelTarget] = useState<FaultPolicyView | undefined>(undefined);

  const del = useMutation({
    mutationFn: (row: FaultPolicyView) => api.deleteFaultPolicy(row.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.faultPolicies() });
      toast(t('faultPolicies.deleted'));
      setDelTarget(undefined);
    },
    onError: mutationError(t),
  });

  useSetConsoleAction(
    () => (
      <Button variant="ghost" onClick={() => setCreateOpen(true)}>
        <PlusIcon size={14} weight="bold" /> {t('faultPolicies.new')}
      </Button>
    ),
    [t],
  );

  const cols: Column<FaultPolicyView>[] = [
    {
      key: 'name',
      header: t('faultPolicies.cols.name'),
      sortable: true,
      sortValue: (r) => r.name,
      cell: (r) => <strong>{r.name}</strong>,
      width: '200px',
    },
    {
      key: 'mode',
      header: t('faultPolicies.cols.mode'),
      cell: (r) =>
        r.fast_fail
          ? t('faultPolicies.mode.fastFail')
          : t('faultPolicies.mode.retryN', { n: r.retry_count }),
      width: '120px',
    },
    {
      key: 'backoff',
      header: t('faultPolicies.cols.backoff'),
      cell: (r) =>
        r.fast_fail || r.retry_count === 0
          ? '—'
          : `${t('faultPolicies.backoff.' + r.backoff_type, r.backoff_type)} · ${String(r.backoff_ms)}ms`,
      width: '160px',
    },
    {
      key: 'timeouts',
      header: t('faultPolicies.cols.timeouts'),
      cell: (r) => (
        <span className="tabular" style={{ fontSize: 'var(--fs-caption)', color: 'var(--muted)' }}>
          {t('faultPolicies.timeoutSummary', {
            connect: ms(r.connect_timeout_ms),
            ttft: ms(r.ttft_timeout_ms),
            total: ms(r.total_timeout_ms),
            idle: ms(r.idle_timeout_ms),
          })}
        </span>
      ),
    },
    {
      key: 'triggers',
      header: t('faultPolicies.cols.triggers'),
      cell: (r) => {
        const codes = r.retry_codes?.length ?? 0;
        const msgs = r.retry_messages?.length ?? 0;
        return codes + msgs === 0 ? '—' : t('faultPolicies.triggerSummary', { codes, msgs });
      },
      width: '120px',
    },
    {
      key: 'status',
      header: t('faultPolicies.cols.status'),
      noClip: true,
      cell: (r) => <StatusBadge tone={statusTone(r.status)} label={t('status.' + r.status, r.status)} />,
      width: '100px',
    },
  ];

  return (
    // Consistent with the sibling list pages: no own scroll/padding wrapper, no
    // in-page title (the TopBar renders the title + subtitle).
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
      <DataTable
        columns={cols}
        rows={data ?? []}
        rowKey={(r) => r.id}
        loading={isLoading}
        empty={t('faultPolicies.empty')}
        searchable
        pageSize={20}
        actionsWidth="96px"
        rowActions={(r) => (
          <>
            <RowAction icon={PencilSimpleIcon} label={t('common.edit')} onClick={() => setEditId(r.id)} />
            <RowAction icon={TrashIcon} label={t('common.delete')} danger onClick={() => setDelTarget(r)} />
          </>
        )}
      />

      {createOpen && <FaultPolicyEditor open onClose={() => setCreateOpen(false)} />}
      {editId !== null && (
        <FaultPolicyEditor
          key={editId}
          row={(data ?? []).find((p) => p.id === editId)}
          open
          onClose={() => setEditId(null)}
        />
      )}

      <ConfirmDialog
        open={delTarget !== undefined}
        title={t('faultPolicies.confirm.deleteTitle')}
        message={t('faultPolicies.confirm.deleteMsg', { name: delTarget?.name ?? '' })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        danger
        loading={del.isPending}
        onConfirm={() => {
          if (delTarget) del.mutate(delTarget);
        }}
        onClose={() => setDelTarget(undefined)}
      />
    </div>
  );
}

type Mode = 'retry' | 'fastFail';
type Status = 'active' | 'disabled';
type Backoff = 'fixed' | 'exponential';

/** Convert a NumberField ms value to the wire value: 0/empty → null (client default). */
function timeoutOrNull(n: number): number | null {
  return n > 0 ? n : null;
}

/**
 * Create/edit `Drawer` for a fault-tolerance policy. `row === undefined` →
 * create. Mode toggles same-channel retry vs fast-fail; the four timeouts are ms
 * (0 → client default); retry triggers are HTTP codes + message substrings
 * (empty → the adapter's built-in retryable verdict). Create carries an
 * Idempotency-Key; update (PATCH) sends nullable fields to clear them.
 */
function FaultPolicyEditor({
  row,
  open,
  onClose,
}: {
  row?: FaultPolicyView;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  const editing = row !== undefined;

  const [name, setName] = useState(row?.name ?? '');
  const [mode, setMode] = useState<Mode>(row?.fast_fail ? 'fastFail' : 'retry');
  const [retryCount, setRetryCount] = useState(row?.retry_count ?? 3);
  const [backoffType, setBackoffType] = useState<Backoff>((row?.backoff_type ?? 'fixed') as Backoff);
  const [backoffMs, setBackoffMs] = useState(row?.backoff_ms ?? 0);
  const [connectMs, setConnectMs] = useState(row?.connect_timeout_ms ?? 0);
  const [ttftMs, setTtftMs] = useState(row?.ttft_timeout_ms ?? 0);
  const [totalMs, setTotalMs] = useState(row?.total_timeout_ms ?? 0);
  const [idleMs, setIdleMs] = useState(row?.idle_timeout_ms ?? 0);
  const [codes, setCodes] = useState<string[]>((row?.retry_codes ?? []).map(String));
  const [messages, setMessages] = useState<string[]>(row?.retry_messages ?? []);
  const [status, setStatus] = useState<Status>((row?.status as Status | undefined) ?? 'active');
  const [description, setDescription] = useState(row?.description ?? '');
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    if (row === undefined) return;
    setName(row.name);
    setMode(row.fast_fail ? 'fastFail' : 'retry');
    setRetryCount(row.retry_count);
    setBackoffType(row.backoff_type as Backoff);
    setBackoffMs(row.backoff_ms);
    setConnectMs(row.connect_timeout_ms ?? 0);
    setTtftMs(row.ttft_timeout_ms ?? 0);
    setTotalMs(row.total_timeout_ms ?? 0);
    setIdleMs(row.idle_timeout_ms ?? 0);
    setCodes((row.retry_codes ?? []).map(String));
    setMessages(row.retry_messages ?? []);
    setStatus((row.status as Status | undefined) ?? 'active');
    setDescription(row.description ?? '');
  }, [row]);

  const nameMissing = name.trim() === '';
  // Parse the code chips to valid HTTP statuses (100–599); silently drop junk.
  const parsedCodes = codes
    .map((c) => Number(c))
    .filter((n) => Number.isInteger(n) && n >= 100 && n <= 599);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        fastFail: mode === 'fastFail',
        retryCount: mode === 'fastFail' ? 0 : retryCount,
        backoffType,
        backoffMs,
        connectTimeoutMs: timeoutOrNull(connectMs),
        ttftTimeoutMs: timeoutOrNull(ttftMs),
        totalTimeoutMs: timeoutOrNull(totalMs),
        idleTimeoutMs: timeoutOrNull(idleMs),
        retryCodes: parsedCodes,
        retryMessages: messages,
        status,
      };
      if (editing) {
        return api.updateFaultPolicy(row.id, {
          ...body,
          description: description.trim() === '' ? null : description.trim(),
        });
      }
      return api.createFaultPolicy(
        { ...body, description: description.trim() === '' ? undefined : description.trim() },
        crypto.randomUUID(),
      );
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.faultPolicies() });
      toast(t(editing ? 'faultPolicies.updated' : 'faultPolicies.created'));
      onClose();
    },
    onError: mutationError(t),
  });

  const onSave = () => {
    setAttempted(true);
    if (!nameMissing) save.mutate();
  };

  return (
    <Drawer
      open={open}
      title={t(editing ? 'faultPolicies.editTitle' : 'faultPolicies.new')}
      onClose={onClose}
      footer={
        <Button variant="cta" onClick={onSave} loading={save.isPending}>
          {t('faultPolicies.save')}
        </Button>
      }
    >
      <TextField
        label={t('faultPolicies.form.name')}
        value={name}
        onChange={setName}
        required
        error={attempted && nameMissing ? t('faultPolicies.form.nameRequired') : undefined}
      />

      <SelectField
        label={t('faultPolicies.form.mode')}
        tooltip={t('faultPolicies.tip.mode')}
        value={mode}
        onChange={(v) => setMode(v as Mode)}
        options={[
          { value: 'retry', label: t('faultPolicies.mode.retry') },
          { value: 'fastFail', label: t('faultPolicies.mode.fastFail') },
        ]}
      />

      {mode === 'retry' && (
        <>
          <NumberField
            label={t('faultPolicies.form.retryCount')}
            value={retryCount}
            onChange={setRetryCount}
            min={0}
            max={20}
            step={1}
          />
          <SelectField
            label={t('faultPolicies.form.backoffType')}
            value={backoffType}
            onChange={(v) => setBackoffType(v as Backoff)}
            options={[
              { value: 'fixed', label: t('faultPolicies.backoff.fixed') },
              { value: 'exponential', label: t('faultPolicies.backoff.exponential') },
            ]}
          />
          <NumberField
            label={t('faultPolicies.form.backoffMs')}
            hint={t('faultPolicies.tip.backoffMs')}
            value={backoffMs}
            onChange={setBackoffMs}
            min={0}
            step={100}
          />
        </>
      )}

      <NumberField
        label={t('faultPolicies.form.connectMs')}
        hint={t('faultPolicies.tip.timeoutZero')}
        value={connectMs}
        onChange={setConnectMs}
        min={0}
        step={1000}
      />
      <NumberField
        label={t('faultPolicies.form.ttftMs')}
        hint={t('faultPolicies.tip.ttft')}
        value={ttftMs}
        onChange={setTtftMs}
        min={0}
        step={1000}
      />
      <NumberField
        label={t('faultPolicies.form.totalMs')}
        hint={t('faultPolicies.tip.timeoutZero')}
        value={totalMs}
        onChange={setTotalMs}
        min={0}
        step={1000}
      />
      <NumberField
        label={t('faultPolicies.form.idleMs')}
        hint={t('faultPolicies.tip.idle')}
        value={idleMs}
        onChange={setIdleMs}
        min={0}
        step={1000}
      />

      <ChipsField
        label={t('faultPolicies.form.retryCodes')}
        tooltip={t('faultPolicies.tip.retryCodes')}
        value={codes}
        onChange={setCodes}
        suggestions={['429', '500', '502', '503', '504', '404', '408']}
        placeholder={t('faultPolicies.form.retryCodesPlaceholder')}
      />
      <ChipsField
        label={t('faultPolicies.form.retryMessages')}
        tooltip={t('faultPolicies.tip.retryMessages')}
        value={messages}
        onChange={setMessages}
        placeholder={t('faultPolicies.form.retryMessagesPlaceholder')}
      />

      <SelectField
        label={t('faultPolicies.form.status')}
        value={status}
        onChange={(v) => setStatus(v as Status)}
        options={[
          { value: 'active', label: t('status.active') },
          { value: 'disabled', label: t('status.disabled') },
        ]}
      />
      <TextField
        label={t('faultPolicies.form.description')}
        value={description}
        onChange={setDescription}
      />
    </Drawer>
  );
}
