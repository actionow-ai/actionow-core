import { PencilSimpleIcon, PlusIcon, TrashIcon, XIcon } from '@phosphor-icons/react';
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
import { IconButton } from '../../components/ui/IconButton';
import { NumberField } from '../../components/ui/NumberField';
import { Pill } from '../../components/ui/Pill';
import { RowAction } from '../../components/ui/RowAction';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { LimitPlanView, LimitRuleInput, LimitRuleView } from '../../lib/api/types';
import { useConsoleApi } from '../../lib/api/useConsoleApi';
import { AdminOnlyNote } from './AdminOnlyNote';
import { useTenantRole } from './useTenantRole';

const DIMENSIONS = ['spend', 'requests', 'tokens', 'rpm', 'concurrency'] as const;
type Dim = (typeof DIMENSIONS)[number];
/** Periods valid for the accumulating dimensions (spend/requests/tokens). */
const ACCUM_PERIODS = ['day', 'month', 'rolling_24h', 'rolling_30d', 'total'] as const;

/** 1 credit ($1) = 1e6 µUSD — `spend` caps are entered in credits, stored as µUSD. */
const MICRO = 1_000_000;

function capKind(dim: Dim): 'money' | 'count' {
  return dim === 'spend' ? 'money' : 'count';
}

/** The default period when a rule's dimension changes. */
function defaultPeriod(dim: Dim): string | null {
  if (dim === 'rpm') return 'minute';
  if (dim === 'concurrency') return null;
  return 'month';
}

/**
 * The tenant 额度套餐 (governance limit plans) page on `/app` — the Part-A
 * surface of the end-user data plane. Mirrors the operator `LimitPlansPage`
 * (`DataTable` of reusable plans + a create/edit `Drawer` with an inline
 * `limit_rule` list) but consumes the TENANT-scoped `/console/limit-plans*`
 * routes: every plan is forced to the caller's tenant server-side (the token
 * scopes it — never a body field; a cross-tenant id → 404). A plan is bound to a
 * subject on the Subjects page; an unbound subject is unlimited.
 *
 * Tenant-admin-only: a member who deep-links here sees an admin-only note (the
 * nav item is hidden and the action is suppressed); the backend
 * `TenantAdminGuard` 403s every write regardless — the gate here is UX, never
 * the security boundary.
 */
export function AppLimitPlans() {
  const { t } = useTranslation('console');
  const api = useConsoleApi();
  const qc = useQueryClient();
  const { isTenantAdmin, isLoading: roleLoading } = useTenantRole();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: qk.consoleLimitPlans(),
    queryFn: () => api.listLimitPlans(),
    enabled: isTenantAdmin,
  });

  const [editId, setEditId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [delTarget, setDelTarget] = useState<LimitPlanView | undefined>(undefined);

  const del = useMutation({
    mutationFn: (row: LimitPlanView) => api.deleteLimitPlan(row.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.consoleLimitPlans() });
      toast(t('limitPlans.deleted'));
      setDelTarget(undefined);
    },
    onError: mutationError(t),
  });

  useSetConsoleAction(
    () =>
      isTenantAdmin ? (
        <Button variant="ghost" onClick={() => setCreateOpen(true)}>
          <PlusIcon size={14} weight="bold" /> {t('limitPlans.new')}
        </Button>
      ) : null,
    [t, isTenantAdmin],
  );

  const cols: Column<LimitPlanView>[] = [
    {
      key: 'name',
      header: t('limitPlans.cols.name'),
      sortable: true,
      sortValue: (r) => r.name,
      cell: (r) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <strong>{r.name}</strong>
          {r.description !== null && r.description !== '' && (
            <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--faint)' }}>
              {r.description}
            </span>
          )}
        </div>
      ),
      width: '220px',
    },
    {
      key: 'rules',
      header: t('limitPlans.cols.rules'),
      cell: (r) =>
        r.rules.length === 0 ? (
          <span style={{ color: 'var(--faint)' }}>—</span>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {r.rules.map((rule, i) => (
              <Pill key={i} tone="idle" title={ruleTitle(rule, t)}>
                {ruleLabel(rule, t)}
              </Pill>
            ))}
          </div>
        ),
    },
    {
      key: 'bindings',
      header: t('limitPlans.cols.bindings'),
      cell: (r) => (
        <span className="tabular" style={{ fontSize: 'var(--fs-caption)', color: 'var(--muted)' }}>
          {t('limitPlans.bindingSummary', { keys: r.key_count, tenants: r.tenant_count })}
        </span>
      ),
      width: '140px',
    },
    {
      key: 'status',
      header: t('limitPlans.cols.status'),
      noClip: true,
      cell: (r) => (
        <StatusBadge tone={statusTone(r.status)} label={t('status.' + r.status, r.status)} />
      ),
      width: '100px',
    },
  ];

  if (!isTenantAdmin) {
    // Still resolving the seat: render nothing rather than flashing the admin-only
    // notice to an admin who hard-refreshes directly on this route.
    if (roleLoading) return null;
    return <AdminOnlyNote variant="page" message={t('app.limitPlans.adminOnly')} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
      <DataTable
        columns={cols}
        rows={data ?? []}
        rowKey={(r) => r.id}
        loading={isLoading}
        error={isError}
        onRetry={() => void refetch()}
        empty={t('limitPlans.empty')}
        searchable
        pageSize={20}
        actionsWidth="96px"
        rowActions={(r) => (
          <>
            <RowAction
              icon={PencilSimpleIcon}
              label={t('common.edit')}
              onClick={() => setEditId(r.id)}
            />
            <RowAction
              icon={TrashIcon}
              label={t('common.delete')}
              danger
              onClick={() => setDelTarget(r)}
            />
          </>
        )}
      />

      {createOpen && <LimitPlanEditor open onClose={() => setCreateOpen(false)} />}
      {editId !== null && (
        <LimitPlanEditor
          key={editId}
          row={(data ?? []).find((p) => p.id === editId)}
          open
          onClose={() => setEditId(null)}
        />
      )}

      <ConfirmDialog
        open={delTarget !== undefined}
        title={t('limitPlans.confirm.deleteTitle')}
        message={t('limitPlans.confirm.deleteMsg', { name: delTarget?.name ?? '' })}
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

type TFunc = ReturnType<typeof useTranslation>['t'];

/** A compact rule chip label, e.g. "消费 $100/月" or "RPM 60". */
function ruleLabel(r: LimitRuleView, t: TFunc): string {
  const dim = t('limitPlans.dim.' + r.dimension, r.dimension);
  if (r.dimension === 'rpm') return `${dim} ${r.cap}`;
  if (r.dimension === 'concurrency') return `${dim} ${r.cap}`;
  const cap =
    r.dimension === 'spend' ? `$${(Number(r.cap) / MICRO).toString()}` : Number(r.cap).toString();
  const period = r.period !== null ? t('limitPlans.period.' + r.period, r.period) : '';
  return `${dim} ${cap}${period ? `/${period}` : ''}`;
}

/** A full rule tooltip including model scope + alert %. */
function ruleTitle(r: LimitRuleView, t: TFunc): string {
  const parts = [ruleLabel(r, t)];
  if (r.model_scope !== null) parts.push(`@${r.model_scope}`);
  if (r.alert_pct !== null) parts.push(t('limitPlans.alertAt', { pct: r.alert_pct }));
  return parts.join(' · ');
}

type Status = 'active' | 'disabled';

/** A single editable rule row in the editor (cap in display units: credits for spend). */
interface RuleDraft {
  key: string;
  dimension: Dim;
  period: string | null;
  cap: number;
  modelScope: string;
  alertPct: number;
}

let RULE_SEQ = 0;
function newRule(): RuleDraft {
  RULE_SEQ += 1;
  return {
    key: `r${String(RULE_SEQ)}`,
    dimension: 'spend',
    period: 'month',
    cap: 0,
    modelScope: '',
    alertPct: 80,
  };
}

/** Convert a wire rule view to an editable draft (µUSD → credits for spend). */
function toDraft(r: LimitRuleView): RuleDraft {
  RULE_SEQ += 1;
  return {
    key: `e${String(RULE_SEQ)}`,
    dimension: r.dimension,
    period: r.period,
    cap: r.dimension === 'spend' ? Number(r.cap) / MICRO : Number(r.cap),
    modelScope: r.model_scope ?? '',
    alertPct: r.alert_pct ?? 0,
  };
}

/**
 * Create/edit `Drawer` for a tenant limit plan. `row === undefined` → create.
 * Edits the plan identity (name/description/status) plus an inline rule list; on
 * save the whole rule set is sent (PATCH `rules` REPLACES). The dimension drives
 * the valid period set (`rpm`→minute, `concurrency`→none, others→an accumulating
 * period), and `spend` caps are entered in credits ($) and serialized to µUSD.
 * Writes go through the tenant-scoped console api.
 */
function LimitPlanEditor({
  row,
  open,
  onClose,
}: {
  row?: LimitPlanView;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('console');
  const api = useConsoleApi();
  const qc = useQueryClient();
  const editing = row !== undefined;

  const [name, setName] = useState(row?.name ?? '');
  const [description, setDescription] = useState(row?.description ?? '');
  const [status, setStatus] = useState<Status>((row?.status as Status | undefined) ?? 'active');
  const [rules, setRules] = useState<RuleDraft[]>(row ? row.rules.map(toDraft) : []);
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    if (row === undefined) return;
    setName(row.name);
    setDescription(row.description ?? '');
    setStatus((row.status as Status | undefined) ?? 'active');
    setRules(row.rules.map(toDraft));
  }, [row]);

  const nameMissing = name.trim() === '';

  const patchRule = (key: string, patch: Partial<RuleDraft>) =>
    setRules((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const onDimChange = (key: string, dim: Dim) =>
    patchRule(key, { dimension: dim, period: defaultPeriod(dim) });

  const save = useMutation({
    mutationFn: () => {
      const wireRules: LimitRuleInput[] = rules.map((r) => ({
        dimension: r.dimension,
        period: r.period as LimitRuleInput['period'],
        cap: r.dimension === 'spend' ? Math.round(r.cap * MICRO) : Math.round(r.cap),
        modelScope: r.modelScope.trim() === '' ? null : r.modelScope.trim(),
        // alert_pct only applies to accumulating budgets; rpm/concurrency ignore it.
        alertPct:
          r.dimension === 'rpm' || r.dimension === 'concurrency' || r.alertPct <= 0
            ? null
            : r.alertPct,
      }));
      if (editing) {
        return api.updateLimitPlan(row.id, {
          name: name.trim(),
          description: description.trim() === '' ? null : description.trim(),
          status,
          rules: wireRules,
        });
      }
      return api.createLimitPlan({
        name: name.trim(),
        description: description.trim() === '' ? null : description.trim(),
        status,
        rules: wireRules,
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.consoleLimitPlans() });
      toast(t(editing ? 'limitPlans.updated' : 'limitPlans.created'));
      onClose();
    },
    onError: mutationError(t),
  });

  const onSave = () => {
    setAttempted(true);
    if (!nameMissing) save.mutate();
  };

  const dimOptions = DIMENSIONS.map((d) => ({ value: d, label: t('limitPlans.dim.' + d, d) }));

  return (
    <Drawer
      open={open}
      width="min(560px, 96vw)"
      title={t(editing ? 'limitPlans.editTitle' : 'limitPlans.new')}
      onClose={onClose}
      footer={
        <Button variant="cta" onClick={onSave} loading={save.isPending}>
          {t('limitPlans.save')}
        </Button>
      }
    >
      <TextField
        label={t('limitPlans.form.name')}
        value={name}
        onChange={setName}
        required
        error={attempted && nameMissing ? t('limitPlans.form.nameRequired') : undefined}
      />
      <TextField
        label={t('limitPlans.form.description')}
        value={description}
        onChange={setDescription}
      />
      <SelectField
        label={t('limitPlans.form.status')}
        value={status}
        onChange={(v) => setStatus(v as Status)}
        options={[
          { value: 'active', label: t('status.active') },
          { value: 'disabled', label: t('status.disabled') },
        ]}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-medium)' }}>
            {t('limitPlans.form.rules')}
          </span>
          <Button variant="ghost" size="sm" onClick={() => setRules((rs) => [...rs, newRule()])}>
            <PlusIcon size={14} weight="bold" /> {t('limitPlans.form.addRule')}
          </Button>
        </div>

        {rules.length === 0 && (
          <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--faint)' }}>
            {t('limitPlans.form.noRules')}
          </span>
        )}

        {rules.map((r) => {
          const accum = r.dimension !== 'rpm' && r.dimension !== 'concurrency';
          return (
            <div
              key={r.key}
              className="panel"
              style={{
                borderRadius: 'var(--r-md)',
                padding: 'var(--s-3)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--s-2)',
              }}
            >
              <div style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <SelectField
                    label={t('limitPlans.form.dimension')}
                    value={r.dimension}
                    onChange={(v) => onDimChange(r.key, v as Dim)}
                    options={dimOptions}
                  />
                </div>
                {accum && (
                  <div style={{ flex: 1 }}>
                    <SelectField
                      label={t('limitPlans.form.period')}
                      value={r.period ?? 'month'}
                      onChange={(v) => patchRule(r.key, { period: v })}
                      options={ACCUM_PERIODS.map((p) => ({
                        value: p,
                        label: t('limitPlans.period.' + p, p),
                      }))}
                    />
                  </div>
                )}
                <div style={{ paddingTop: 22 }}>
                  <IconButton
                    icon={XIcon}
                    label={t('limitPlans.form.removeRule')}
                    onClick={() => setRules((rs) => rs.filter((x) => x.key !== r.key))}
                    bare
                  />
                </div>
              </div>

              <div style={{ display: 'flex', gap: 'var(--s-2)' }}>
                <div style={{ flex: 1 }}>
                  <NumberField
                    label={
                      capKind(r.dimension) === 'money'
                        ? t('limitPlans.form.capCredits')
                        : t('limitPlans.form.capCount')
                    }
                    value={r.cap}
                    onChange={(v) => patchRule(r.key, { cap: v })}
                    min={0}
                  />
                </div>
                {accum && (
                  <div style={{ flex: 1 }}>
                    <NumberField
                      label={t('limitPlans.form.alertPct')}
                      hint={t('limitPlans.form.alertPctHint')}
                      value={r.alertPct}
                      onChange={(v) => patchRule(r.key, { alertPct: v })}
                      min={0}
                      max={100}
                    />
                  </div>
                )}
              </div>

              <TextField
                label={t('limitPlans.form.modelScope')}
                hint={t('limitPlans.form.modelScopeHint')}
                value={r.modelScope}
                onChange={(v) => patchRule(r.key, { modelScope: v })}
              />
            </div>
          );
        })}
      </div>
    </Drawer>
  );
}
