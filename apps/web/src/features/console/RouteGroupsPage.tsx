import { PencilSimpleIcon, PlusIcon, StackIcon, TrashIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Drawer } from '../../components/ui/Drawer';
import { NumberField } from '../../components/ui/NumberField';
import { RowAction } from '../../components/ui/RowAction';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ChannelView, RouteGroupView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

const BASELINE_BPS = 10000;

/** A stable cache key for the flattened all-resources channel roster (add-picker + labels). */
const QK_CHANNEL_ROSTER = ['admin', 'channel-roster'] as const;

/** bps → a `×N.NN` multiplier string. */
function ratioMultiplier(bps: number): string {
  return (bps / BASELINE_BPS).toFixed(2);
}
/** bps → a signed delta-percent vs the ×1.00 baseline (e.g. +50, -20). */
function ratioDeltaPct(bps: number): number {
  return Math.round((bps - BASELINE_BPS) / 100);
}
/** A human channel label from a real ChannelView. */
function channelLabel(c: ChannelView): string {
  return `${c.provider_type} · ${c.model ?? c.id}`;
}

/**
 * The 分组 (route groups) console page — now wired to the live `/admin/route-groups`
 * backend. A `DataTable` of groups with their price 倍率 (group_ratio_bps, which
 * drives real customer billing), status, description and channel count; a
 * create/edit `Drawer`; a per-group 管理渠道 (manage channels) `Drawer` with
 * priority/weight membership editing via the idempotent PUT upsert; and per-row
 * delete. The ratio is entered as a percent (150 → ×1.50) and stored as basis
 * points (15000). Membership count derives from the cached `routeGroupChannels`
 * query (the backend returns a page, not a sync count).
 */
export function RouteGroupsPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: qk.routeGroups(),
    queryFn: api.listRouteGroups,
  });

  const [editId, setEditId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [manageId, setManageId] = useState<string | null>(null);
  const [delTarget, setDelTarget] = useState<RouteGroupView | undefined>(undefined);

  const del = useMutation({
    mutationFn: (row: RouteGroupView) => api.deleteRouteGroup(row.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.routeGroups() });
      toast(t('groups.deleted'));
      setDelTarget(undefined);
    },
    onError: mutationError(t),
  });

  useSetConsoleAction(
    () => (
      <Button variant="ghost" onClick={() => setCreateOpen(true)}>
        <PlusIcon size={14} weight="bold" /> {t('groups.new')}
      </Button>
    ),
    [t],
  );

  const cols: Column<RouteGroupView>[] = [
    {
      key: 'name',
      header: t('groups.cols.name'),
      sortable: true,
      sortValue: (r) => r.name,
      cell: (r) => <strong>{r.name}</strong>,
      width: '180px',
    },
    {
      key: 'ratio',
      header: t('groups.cols.ratio'),
      sortable: true,
      sortValue: (r) => r.group_ratio_bps,
      cell: (r) => {
        const delta = ratioDeltaPct(r.group_ratio_bps);
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-2)' }}>
            <span className="tabular" style={{ fontWeight: 'var(--fw-medium)' }}>
              ×{ratioMultiplier(r.group_ratio_bps)}
            </span>
            <span className="tabular" style={{ color: delta === 0 ? 'var(--faint)' : 'var(--muted)' }}>
              {delta >= 0 ? '+' : ''}
              {delta}%
            </span>
          </span>
        );
      },
      width: '140px',
    },
    {
      key: 'status',
      header: t('groups.cols.status'),
      cell: (r) => <StatusBadge tone={statusTone(r.status)} label={t('status.' + r.status, r.status)} />,
      width: '100px',
    },
    {
      key: 'description',
      header: t('groups.cols.description'),
      cell: (r) => r.description ?? '—',
    },
    {
      key: 'channels',
      header: t('groups.cols.channels'),
      cell: (r) => <ChannelCount groupId={r.id} />,
      width: '96px',
    },
  ];

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 'var(--s-2) var(--s-3) var(--s-4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)', marginBottom: 'var(--s-3)' }}>
        <h1 style={{ margin: 0, fontSize: 'var(--fs-md)', fontWeight: 'var(--fw-semibold)' }}>
          {t('groups.title')}
        </h1>
      </div>

      <DataTable
        columns={cols}
        rows={data ?? []}
        rowKey={(r) => r.id}
        loading={isLoading}
        empty={t('groups.empty')}
        searchable
        pageSize={20}
        actionsWidth="132px"
        rowActions={(r) => (
          <>
            <RowAction icon={PencilSimpleIcon} label={t('common.edit')} onClick={() => setEditId(r.id)} />
            <RowAction
              icon={StackIcon}
              label={t('groups.actions.manageChannels')}
              onClick={() => setManageId(r.id)}
            />
            <RowAction icon={TrashIcon} label={t('common.delete')} danger onClick={() => setDelTarget(r)} />
          </>
        )}
      />

      {createOpen && <RouteGroupEditor open onClose={() => setCreateOpen(false)} />}
      {editId !== null && (
        <RouteGroupEditor
          key={editId}
          row={(data ?? []).find((g) => g.id === editId)}
          open
          onClose={() => setEditId(null)}
        />
      )}
      {manageId !== null && (
        <GroupChannelsDrawer
          key={manageId}
          group={(data ?? []).find((g) => g.id === manageId)}
          open
          onClose={() => setManageId(null)}
        />
      )}

      <ConfirmDialog
        open={delTarget !== undefined}
        title={t('groups.confirm.deleteTitle')}
        message={t('groups.confirm.deleteMsg', { name: delTarget?.name ?? '' })}
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

/** The membership count for one group, read from the cached per-group channels query. */
function ChannelCount({ groupId }: { groupId: string }) {
  const api = useAdminApi();
  const { data } = useQuery({
    queryKey: qk.routeGroupChannels(groupId),
    queryFn: () => api.listGroupChannels(groupId),
  });
  return <span className="tabular">{data?.length ?? '—'}</span>;
}

const GROUP_STATUSES = [
  { value: 'active', labelKey: 'status.active' },
  { value: 'disabled', labelKey: 'status.disabled' },
];

/**
 * Create/edit `Drawer` for a route group. `row === undefined` → create. The ratio
 * is entered as a percent (100 = ×1.00) and stored as basis points; a hint shows
 * `×N.NN (+P%) · BBBB bps`. Write body is camelCase `groupRatioBps`; create carries
 * an Idempotency-Key, update (PATCH) sends `description: null` to clear it.
 */
function RouteGroupEditor({
  row,
  open,
  onClose,
}: {
  row?: RouteGroupView;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  const editing = row !== undefined;

  const [name, setName] = useState(row?.name ?? '');
  // Edited as a percent; baseline 100 = ×1.00. Stored as bps = percent * 100.
  const [ratioPct, setRatioPct] = useState((row?.group_ratio_bps ?? BASELINE_BPS) / 100);
  const [status, setStatus] = useState<'active' | 'disabled'>(
    (row?.status as 'active' | 'disabled' | undefined) ?? 'active',
  );
  const [description, setDescription] = useState(row?.description ?? '');

  useEffect(() => {
    if (row === undefined) return;
    setName(row.name);
    setRatioPct(row.group_ratio_bps / 100);
    setStatus((row.status as 'active' | 'disabled' | undefined) ?? 'active');
    setDescription(row.description ?? '');
  }, [row]);

  const bps = Math.round(ratioPct * 100);
  const delta = ratioDeltaPct(bps);

  const save = useMutation({
    mutationFn: () => {
      const desc = description.trim();
      if (editing) {
        return api.updateRouteGroup(row.id, {
          name: name.trim(),
          groupRatioBps: bps,
          status,
          description: desc === '' ? null : desc, // null clears
        });
      }
      return api.createRouteGroup(
        { name: name.trim(), groupRatioBps: bps, status, description: desc === '' ? undefined : desc },
        crypto.randomUUID(),
      );
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.routeGroups() });
      toast(t(editing ? 'groups.updated' : 'groups.created'));
      onClose();
    },
    onError: mutationError(t),
  });

  return (
    <Drawer
      open={open}
      title={t(editing ? 'groups.editTitle' : 'groups.new')}
      onClose={onClose}
      footer={
        <Button variant="cta" onClick={() => save.mutate()} loading={save.isPending}>
          {t('groups.save')}
        </Button>
      }
    >
      <TextField label={t('groups.form.name')} tooltip={t('groups.tip.name')} value={name} onChange={setName} required />
      <NumberField
        label={t('groups.form.ratioPercent')}
        tooltip={t('groups.tip.ratioLive')}
        hint={t('groups.ratioEquiv', { mult: ratioMultiplier(bps), sign: delta >= 0 ? '+' : '', pct: delta, bps })}
        value={ratioPct}
        onChange={setRatioPct}
        min={0}
        step={5}
      />
      <SelectField
        label={t('groups.form.status')}
        tooltip={t('groups.tip.status')}
        value={status}
        onChange={(v) => setStatus(v as 'active' | 'disabled')}
        options={GROUP_STATUSES.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
      />
      <TextField
        label={t('groups.form.description')}
        tooltip={t('groups.tip.description')}
        value={description}
        onChange={setDescription}
      />
    </Drawer>
  );
}

/**
 * The 管理渠道 (manage channels) `Drawer`: the membership editor for a group.
 * Lists the group's channels with editable priority + weight (high priority =
 * tried first) and a remove action, plus an "add channel" picker over the real
 * channel roster (all resources' channels, minus those already in the group).
 * Membership writes go through the idempotent PUT upsert — every edit sends BOTH
 * priority and weight so the upsert never resets the other field.
 */
function GroupChannelsDrawer({
  group,
  open,
  onClose,
}: {
  group?: RouteGroupView;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  const groupId = group?.id ?? '';

  const { data: members, isLoading } = useQuery({
    queryKey: qk.routeGroupChannels(groupId),
    queryFn: () => api.listGroupChannels(groupId),
    enabled: groupId !== '',
  });

  const { data: roster } = useQuery({
    queryKey: QK_CHANNEL_ROSTER,
    queryFn: async () => {
      const resources = await api.listResources();
      const lists = await Promise.all(resources.map((r) => api.listChannels(r.id)));
      return lists.flat();
    },
    enabled: groupId !== '',
  });

  const [pickChannel, setPickChannel] = useState('');

  const rosterLabel = (id: string): string => {
    const c = (roster ?? []).find((x) => x.id === id);
    return c ? channelLabel(c) : id;
  };

  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: qk.routeGroupChannels(groupId) });
    await qc.invalidateQueries({ queryKey: qk.routeGroups() });
  };

  const add = useMutation({
    mutationFn: (channelId: string) => api.addGroupChannel(groupId, channelId, { priority: 0, weight: 1 }),
    onSuccess: async () => {
      await invalidate();
      toast(t('groups.channels.added'));
      setPickChannel('');
    },
    onError: mutationError(t),
  });
  // Priority/weight edit = the SAME PUT upsert (must carry both fields, or the
  // omitted one resets to its default).
  const upsert = useMutation({
    mutationFn: ({ channelId, priority, weight }: { channelId: string; priority: number; weight: number }) =>
      api.addGroupChannel(groupId, channelId, { priority, weight }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.routeGroupChannels(groupId) }),
    onError: mutationError(t),
  });
  const remove = useMutation({
    mutationFn: (channelId: string) => api.removeGroupChannel(groupId, channelId),
    onSuccess: async () => {
      await invalidate();
      toast(t('groups.channels.removed'));
    },
    onError: mutationError(t),
  });

  const memberIds = new Set((members ?? []).map((m) => m.channel_id));
  const available = (roster ?? []).filter((c) => !memberIds.has(c.id));

  return (
    <Drawer
      open={open}
      title={t('groups.channels.title', { name: group?.name ?? '' })}
      onClose={onClose}
      width="min(560px, 96vw)"
    >
      {/* Add-channel picker */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--s-2)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <SelectField
            label={t('groups.channels.add')}
            value={pickChannel}
            onChange={setPickChannel}
            placeholder={
              available.length === 0 ? t('groups.channels.allAdded') : t('groups.channels.addPlaceholder')
            }
            options={available.map((c) => ({ value: c.id, label: channelLabel(c) }))}
          />
        </div>
        <Button
          variant="cta"
          onClick={() => add.mutate(pickChannel)}
          loading={add.isPending}
          disabled={pickChannel === ''}
        >
          <PlusIcon size={14} weight="bold" /> {t('groups.channels.add')}
        </Button>
      </div>

      {/* Membership list */}
      {isLoading ? null : (members ?? []).length === 0 ? (
        <div
          className="panel"
          style={{
            borderRadius: 'var(--r-md)',
            padding: 'var(--s-5)',
            textAlign: 'center',
            color: 'var(--muted)',
            fontSize: 'var(--fs-sm)',
          }}
        >
          {t('groups.channels.empty')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
          {(members ?? []).map((m) => (
            <div
              key={m.channel_id}
              className="panel"
              style={{ borderRadius: 'var(--r-md)', padding: 'var(--s-3)', display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--s-2)' }}>
                <strong style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {rosterLabel(m.channel_id)}
                </strong>
                <Button variant="ghost" size="sm" onClick={() => remove.mutate(m.channel_id)}>
                  <TrashIcon size={14} weight="bold" /> {t('groups.channels.remove')}
                </Button>
              </div>
              <div style={{ display: 'flex', gap: 'var(--s-3)' }}>
                <div style={{ flex: 1 }}>
                  <NumberField
                    label={t('groups.channels.cols.priority')}
                    hint={t('groups.channels.priorityHint')}
                    value={m.priority}
                    onChange={(v) => upsert.mutate({ channelId: m.channel_id, priority: v, weight: m.weight })}
                    min={0}
                    step={10}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <NumberField
                    label={t('groups.channels.cols.weight')}
                    hint={t('groups.channels.weightHint')}
                    value={m.weight}
                    onChange={(v) => upsert.mutate({ channelId: m.channel_id, priority: m.priority, weight: v })}
                    min={0}
                    step={10}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Drawer>
  );
}
