import { KeyIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { BalanceCard } from '../../components/data/BalanceCard';
import { CopyField } from '../../components/data/CopyField';
import { LimitUsageBars } from '../../components/data/LimitUsageBars';
import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';
import { NumberField } from '../../components/ui/NumberField';
import { Pill } from '../../components/ui/Pill';
import { SelectField } from '../../components/ui/SelectField';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ApiKeyView, SubjectView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_DETAIL, STALE_REFERENCE } from '../../lib/query';

const panel = {
  borderRadius: 'var(--r-md)',
  padding: 'var(--s-4)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--s-3)',
} as const;

const sectionTitle = {
  fontSize: 'var(--fs-sm)',
  fontWeight: 'var(--fw-medium)',
} as const;

/**
 * Inline master-detail panel for one subject (end-user) inside the tenant drawer's
 * End-users tab. Surfaces the per-subject backend that previously had no UI: the
 * 额度套餐 (limit plan) binding + usage bars, the HARD sub-wallet (open / top-up /
 * transfer with the tenant pool), and subject-scoped API keys (list + mint). Kept
 * inline (not a nested drawer) to avoid stacking a second focus trap.
 */
export function SubjectDetailPanel({
  tenantId,
  subject,
  planOptions,
  onClose,
}: {
  tenantId: string;
  subject: SubjectView;
  planOptions: { value: string; label: string }[];
  onClose: () => void;
}) {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();

  // Sub-wallet — 404 (no wallet opened yet) maps to null, not an error state.
  const wallet = useQuery({
    queryKey: qk.subAccount(tenantId, subject.id),
    queryFn: async () => {
      try {
        return await api.getSubAccount(tenantId, subject.id);
      } catch {
        return null;
      }
    },
  });
  // Usage-vs-cap for the subject's bound plan (rolling-aware).
  const usage = useQuery({
    queryKey: qk.limitStatus('subject', subject.id),
    queryFn: () => api.listLimitStatus('subject', subject.id, subject.limit_plan_id ?? ''),
    enabled: subject.limit_plan_id !== null,
    staleTime: STALE_DETAIL,
  });
  // The tenant's keys, narrowed to this subject.
  const keys = useQuery({
    queryKey: qk.apiKeys(tenantId),
    queryFn: () => api.listApiKeys(tenantId),
    staleTime: STALE_REFERENCE,
  });
  const subjectKeys = (keys.data ?? []).filter((k: ApiKeyView) => k.subject_id === subject.id);

  const refreshSubjects = () => qc.invalidateQueries({ queryKey: qk.subjects(tenantId) });
  const refreshWallet = () =>
    qc.invalidateQueries({ queryKey: qk.subAccount(tenantId, subject.id) });

  const bindPlan = useMutation({
    mutationFn: (planId: string | null) => api.setSubjectLimitPlan(tenantId, subject.id, planId),
    onSuccess: async () => {
      await refreshSubjects();
      await qc.invalidateQueries({ queryKey: qk.limitStatus('subject', subject.id) });
      toast(t('tenants.detail.users.detail.planBound'));
    },
    onError: mutationError(t),
  });

  // ── sub-wallet ────────────────────────────────────────────────────────────
  const [openCredits, setOpenCredits] = useState(0);
  const [topupCredits, setTopupCredits] = useState(0);
  const [xferCredits, setXferCredits] = useState(0);
  const [xferDir, setXferDir] = useState<'to_subject' | 'to_tenant'>('to_subject');

  const openWallet = useMutation({
    mutationFn: () =>
      api.createSubAccount(
        tenantId,
        subject.id,
        openCredits > 0 ? { credits: openCredits } : {},
        crypto.randomUUID(),
      ),
    onSuccess: async () => {
      await refreshWallet();
      toast(t('tenants.detail.users.detail.walletOpened'));
      setOpenCredits(0);
    },
    onError: mutationError(t),
  });
  const topup = useMutation({
    mutationFn: () =>
      api.topupSubAccount(tenantId, subject.id, { credits: topupCredits }, crypto.randomUUID()),
    onSuccess: async () => {
      await refreshWallet();
      toast(t('accounts.topup.done'));
      setTopupCredits(0);
    },
    onError: mutationError(t),
  });
  const transfer = useMutation({
    mutationFn: () =>
      api.transferSubAccount(tenantId, subject.id, { credits: xferCredits, direction: xferDir }),
    onSuccess: async () => {
      await refreshWallet();
      await qc.invalidateQueries({ queryKey: qk.accounts() });
      toast(t('tenants.detail.users.detail.transferred'));
      setXferCredits(0);
    },
    onError: mutationError(t),
  });

  // ── subject-scoped key minting ──────────────────────────────────────────────
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const mintKey = useMutation({
    mutationFn: () => api.createApiKey({ tenantId, subjectId: subject.id }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: qk.apiKeys(tenantId) });
      setPlaintext(r.plaintext);
    },
    onError: mutationError(t),
  });
  const revokeKey = useMutation({
    mutationFn: (id: string) => api.deleteApiKey(id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.apiKeys(tenantId) });
      toast(t('apiKeys.revoked'));
    },
    onError: mutationError(t),
  });

  const w = wallet.data;

  return (
    <div className="panel" style={{ ...panel, gap: 'var(--s-4)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: 'var(--fs-base)' }}>
          {subject.display_name ?? subject.external_id ?? subject.email ?? subject.id}
        </strong>
        <IconButton icon={XIcon} label={t('common.close')} onClick={onClose} bare />
      </div>

      {/* 额度套餐 binding + usage */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
        <span style={sectionTitle}>{t('tenants.detail.users.detail.plan')}</span>
        <SelectField
          label={t('tenants.detail.plan.label')}
          tooltip={t('tenants.detail.users.detail.planTip')}
          value={subject.limit_plan_id ?? ''}
          onChange={(v) => bindPlan.mutate(v === '' ? null : v)}
          options={planOptions}
          placeholder={t('tenants.detail.plan.none')}
        />
        {subject.limit_plan_id !== null && <LimitUsageBars rules={usage.data ?? []} />}
      </div>

      {/* HARD sub-wallet */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
        <span style={sectionTitle}>{t('tenants.detail.users.detail.wallet')}</span>
        {wallet.isLoading ? (
          <span style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
            {t('common.loading')}
          </span>
        ) : w ? (
          <>
            <BalanceCard
              micro={w.credit_balance}
              label={t('accounts.cols.balance')}
              held={w.credit_held}
              heldLabel={t('accounts.cols.held')}
            />
            <div
              style={{
                display: 'flex',
                gap: 'var(--s-2)',
                alignItems: 'flex-end',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ width: 130 }}>
                <NumberField
                  label={t('accounts.topup.credits')}
                  value={topupCredits}
                  onChange={setTopupCredits}
                  min={0}
                />
              </div>
              <Button
                variant="ghost"
                onClick={() => topup.mutate()}
                loading={topup.isPending}
                disabled={topupCredits <= 0}
              >
                {t('accounts.topup.action')}
              </Button>
            </div>
            <div
              style={{
                display: 'flex',
                gap: 'var(--s-2)',
                alignItems: 'flex-end',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ width: 130 }}>
                <NumberField
                  label={t('tenants.detail.users.detail.transferAmount')}
                  value={xferCredits}
                  onChange={setXferCredits}
                  min={0}
                />
              </div>
              <div style={{ width: 150 }}>
                <SelectField
                  label={t('tenants.detail.users.detail.direction')}
                  value={xferDir}
                  onChange={(v) => setXferDir(v as 'to_subject' | 'to_tenant')}
                  options={[
                    { value: 'to_subject', label: t('tenants.detail.users.detail.toSubject') },
                    { value: 'to_tenant', label: t('tenants.detail.users.detail.toTenant') },
                  ]}
                />
              </div>
              <Button
                variant="ghost"
                onClick={() => transfer.mutate()}
                loading={transfer.isPending}
                disabled={xferCredits <= 0}
              >
                {t('tenants.detail.users.detail.transfer')}
              </Button>
            </div>
          </>
        ) : (
          <div
            style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'flex-end', flexWrap: 'wrap' }}
          >
            <div style={{ width: 130 }}>
              <NumberField
                label={t('tenants.detail.users.detail.openingCredits')}
                value={openCredits}
                onChange={setOpenCredits}
                min={0}
              />
            </div>
            <Button
              variant="cta"
              onClick={() => openWallet.mutate()}
              loading={openWallet.isPending}
            >
              <PlusIcon size={14} weight="bold" /> {t('tenants.detail.users.detail.openWallet')}
            </Button>
          </div>
        )}
      </div>

      {/* subject-scoped api keys */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={sectionTitle}>{t('tenants.detail.users.detail.keys')}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => mintKey.mutate()}
            loading={mintKey.isPending}
          >
            <PlusIcon size={14} weight="bold" /> {t('tenants.detail.users.detail.mintKey')}
          </Button>
        </div>
        {plaintext !== null && (
          <div
            className="panel"
            style={{
              borderRadius: 'var(--r-md)',
              padding: 'var(--s-3)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--s-2)',
            }}
          >
            <span style={{ color: 'var(--run)', fontSize: 'var(--fs-caption)' }}>
              {t('apiKeys.reveal.warn')}
            </span>
            <CopyField
              value={plaintext}
              copyLabel={t('common.copy')}
              copiedLabel={t('common.copied')}
              failedLabel={t('common.copyFailed')}
            />
            <Button variant="ghost" size="sm" onClick={() => setPlaintext(null)}>
              {t('apiKeys.reveal.done')}
            </Button>
          </div>
        )}
        {subjectKeys.length === 0 ? (
          <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-caption)' }}>
            {t('tenants.detail.users.detail.noKeys')}
          </span>
        ) : (
          subjectKeys.map((k) => (
            <div
              key={k.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--s-2)',
                justifyContent: 'space-between',
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <KeyIcon size={14} aria-hidden="true" />
                <code
                  style={{
                    fontSize: 'var(--fs-caption)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {k.id}
                </code>
                <Pill tone={k.status === 'active' ? 'ok' : 'fail'}>
                  {t('status.' + k.status, k.status)}
                </Pill>
              </span>
              {k.status === 'active' && (
                <Button variant="ghost" size="sm" onClick={() => revokeKey.mutate(k.id)}>
                  {t('apiKeys.revoke')}
                </Button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
