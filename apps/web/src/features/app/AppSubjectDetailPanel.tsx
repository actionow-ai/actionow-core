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
import type { ConsoleApiKeyView, SubjectView } from '../../lib/api/types';
import { useConsoleApi } from '../../lib/api/useConsoleApi';
import { STALE_REFERENCE } from '../../lib/query';

const sectionTitle = {
  fontSize: 'var(--fs-sm)',
  fontWeight: 'var(--fw-medium)',
} as const;

/**
 * Per-subject (end-user) detail for the tenant-admin Subjects drawer — the
 * `/app` twin of the operator `SubjectDetailPanel`, but tenant-scoped through the
 * console plane (`useConsoleApi`, no `tenantId` — the token scopes it). Surfaces
 * the 额度套餐 (limit plan) binding + per-subject usage-vs-cap bars (via the
 * tenant-scoped `/console/subjects/:id/limit-status`), the HARD sub-wallet (open /
 * top-up / transfer with the tenant pool), and subject-scoped API keys (list +
 * mint).
 */
export function AppSubjectDetailPanel({
  subject,
  planOptions,
  onClose,
}: {
  subject: SubjectView;
  planOptions: { value: string; label: string }[];
  onClose: () => void;
}) {
  const { t } = useTranslation('console');
  const api = useConsoleApi();
  const qc = useQueryClient();

  // Sub-wallet — a 404 (no wallet opened yet) maps to null, not an error state.
  const wallet = useQuery({
    queryKey: qk.consoleSubAccount(subject.id),
    queryFn: async () => {
      try {
        return await api.getSubAccount(subject.id);
      } catch {
        return null;
      }
    },
  });
  // The tenant's keys, narrowed to this subject (the console list carries subject_id).
  // NOTE: a SEPARATE cache key from AppKeys' `consoleApiKeys()` infinite query — sharing
  // it would clobber that entry's `{pages,pageParams}` shape with this `Page` shape and
  // white-screen AppKeys on its next mount (its `data.pages.flatMap` throws). See queryKeys.
  const keys = useQuery({
    queryKey: qk.consoleApiKeysForSubject(subject.id),
    queryFn: () => api.listApiKeys({ limit: 100 }),
    staleTime: STALE_REFERENCE,
  });
  const subjectKeys = (keys.data?.rows ?? []).filter(
    (k: ConsoleApiKeyView) => k.subject_id === subject.id,
  );

  // Per-subject usage-vs-cap bars — only when a plan is bound (else unlimited).
  const usage = useQuery({
    queryKey: qk.limitStatus('subject', subject.id),
    queryFn: () => api.getSubjectLimitStatus(subject.id),
    enabled: subject.limit_plan_id !== null,
  });

  const refreshSubjects = () => qc.invalidateQueries({ queryKey: qk.consoleSubjects() });
  const refreshWallet = () =>
    qc.invalidateQueries({ queryKey: qk.consoleSubAccount(subject.id) });

  const bindPlan = useMutation({
    mutationFn: (planId: string | null) => api.setSubjectLimitPlan(subject.id, planId),
    onSuccess: async () => {
      await refreshSubjects();
      await qc.invalidateQueries({ queryKey: qk.limitStatus('subject', subject.id) });
      toast(t('app.subjects.detail.planBound'));
    },
    onError: mutationError(t),
  });

  // ── sub-wallet ────────────────────────────────────────────────────────────
  const [openCredits, setOpenCredits] = useState(0);
  const [topupCredits, setTopupCredits] = useState(0);
  const [xferCredits, setXferCredits] = useState(0);
  const [xferDir, setXferDir] = useState<'to_subject' | 'to_tenant'>('to_subject');

  const openWallet = useMutation({
    mutationFn: () => api.openSubAccount(subject.id, openCredits > 0 ? { credits: openCredits } : {}),
    onSuccess: async () => {
      await refreshWallet();
      toast(t('app.subjects.detail.walletOpened'));
      setOpenCredits(0);
    },
    onError: mutationError(t),
  });
  const topup = useMutation({
    mutationFn: () => api.topupSubAccount(subject.id, { credits: topupCredits }),
    onSuccess: async () => {
      await refreshWallet();
      toast(t('app.subjects.detail.toppedUp'));
      setTopupCredits(0);
    },
    onError: mutationError(t),
  });
  const transfer = useMutation({
    mutationFn: () =>
      api.transferSubAccount(subject.id, { credits: xferCredits, direction: xferDir }),
    onSuccess: async () => {
      await refreshWallet();
      await qc.invalidateQueries({ queryKey: qk.consoleBalance() });
      toast(t('app.subjects.detail.transferred'));
      setXferCredits(0);
    },
    onError: mutationError(t),
  });

  // ── subject-scoped key minting ──────────────────────────────────────────────
  const [plaintext, setPlaintext] = useState<string | null>(null);
  // Refresh BOTH lists: this panel's per-subject view AND the AppKeys page's shared
  // `consoleApiKeys()` infinite list (so the main Keys page reflects the change too).
  const refreshKeys = async () => {
    await qc.invalidateQueries({ queryKey: qk.consoleApiKeysForSubject(subject.id) });
    await qc.invalidateQueries({ queryKey: qk.consoleApiKeys() });
  };
  const mintKey = useMutation({
    mutationFn: () => api.createApiKey({ subjectId: subject.id }),
    onSuccess: async (r) => {
      await refreshKeys();
      setPlaintext(r.plaintext);
    },
    onError: mutationError(t),
  });
  const revokeKey = useMutation({
    mutationFn: (id: string) => api.disableApiKey(id),
    onSuccess: async () => {
      await refreshKeys();
      toast(t('app.keys.disabled'));
    },
    onError: mutationError(t),
  });

  const w = wallet.data;

  return (
    <div
      className="panel"
      style={{
        borderRadius: 'var(--r-md)',
        padding: 'var(--s-4)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--s-4)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: 'var(--fs-base)' }}>
          {subject.display_name ?? subject.external_id ?? subject.email ?? subject.id}
        </strong>
        <IconButton icon={XIcon} label={t('forms.close')} onClick={onClose} bare />
      </div>

      {/* 额度套餐 binding */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
        <span style={sectionTitle}>{t('app.subjects.detail.plan')}</span>
        <SelectField
          label={t('app.subjects.detail.plan')}
          tooltip={t('app.subjects.detail.planTip')}
          value={subject.limit_plan_id ?? ''}
          onChange={(v) => bindPlan.mutate(v === '' ? null : v)}
          options={planOptions}
          placeholder={t('app.subjects.detail.planNone')}
        />
        {subject.limit_plan_id !== null && <LimitUsageBars rules={usage.data ?? []} />}
      </div>

      {/* HARD sub-wallet */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
        <span style={sectionTitle}>{t('app.subjects.detail.wallet')}</span>
        {wallet.isLoading ? (
          <span style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
            {t('common.loading')}
          </span>
        ) : w ? (
          <>
            <BalanceCard
              micro={w.credit_balance}
              label={t('app.subjects.detail.balance')}
              held={w.credit_held}
              heldLabel={t('app.subjects.detail.held')}
            />
            <div
              style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'flex-end', flexWrap: 'wrap' }}
            >
              <div style={{ width: 130 }}>
                <NumberField
                  label={t('app.subjects.detail.topupCredits')}
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
                {t('app.subjects.detail.topup')}
              </Button>
            </div>
            <div
              style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'flex-end', flexWrap: 'wrap' }}
            >
              <div style={{ width: 130 }}>
                <NumberField
                  label={t('app.subjects.detail.transferAmount')}
                  value={xferCredits}
                  onChange={setXferCredits}
                  min={0}
                />
              </div>
              <div style={{ width: 170 }}>
                <SelectField
                  label={t('app.subjects.detail.direction')}
                  value={xferDir}
                  onChange={(v) => setXferDir(v as 'to_subject' | 'to_tenant')}
                  options={[
                    { value: 'to_subject', label: t('app.subjects.detail.toSubject') },
                    { value: 'to_tenant', label: t('app.subjects.detail.toTenant') },
                  ]}
                />
              </div>
              <Button
                variant="ghost"
                onClick={() => transfer.mutate()}
                loading={transfer.isPending}
                disabled={xferCredits <= 0}
              >
                {t('app.subjects.detail.transfer')}
              </Button>
            </div>
          </>
        ) : (
          <div
            style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'flex-end', flexWrap: 'wrap' }}
          >
            <div style={{ width: 130 }}>
              <NumberField
                label={t('app.subjects.detail.openingCredits')}
                value={openCredits}
                onChange={setOpenCredits}
                min={0}
              />
            </div>
            <Button variant="cta" onClick={() => openWallet.mutate()} loading={openWallet.isPending}>
              <PlusIcon size={14} weight="bold" /> {t('app.subjects.detail.openWallet')}
            </Button>
          </div>
        )}
      </div>

      {/* subject-scoped api keys */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={sectionTitle}>{t('app.subjects.detail.keys')}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => mintKey.mutate()}
            loading={mintKey.isPending}
          >
            <PlusIcon size={14} weight="bold" /> {t('app.subjects.detail.mintKey')}
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
            {t('app.subjects.detail.noKeys')}
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
                  style={{ fontSize: 'var(--fs-caption)', overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {k.id}
                </code>
                <Pill tone={k.status === 'active' ? 'ok' : 'fail'}>
                  {t('status.' + k.status, k.status)}
                </Pill>
              </span>
              {k.status === 'active' && (
                <Button variant="ghost" size="sm" onClick={() => revokeKey.mutate(k.id)}>
                  {t('app.keys.disable')}
                </Button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
