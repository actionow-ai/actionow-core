import { useMutation, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { QueryBoundary } from '../../components/data/QueryBoundary';
import { StatusBadge } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { Pill } from '../../components/ui/Pill';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import { useConsoleApi } from '../../lib/api/useConsoleApi';
import { STALE_REFERENCE } from '../../lib/query';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 'var(--s-3)',
      }}
    >
      <span
        style={{
          fontSize: 'var(--fs-caption)',
          textTransform: 'uppercase',
          letterSpacing: '.06em',
          color: 'var(--faint)',
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 'var(--fs-sm)', minWidth: 0, textAlign: 'right' }}>{children}</span>
    </div>
  );
}

export function AppSettings() {
  const { t } = useTranslation('console');
  const api = useConsoleApi();

  const me = useQuery({
    queryKey: qk.consoleMe(),
    queryFn: () => api.me(),
    staleTime: STALE_REFERENCE,
  });
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');

  const change = useMutation({
    mutationFn: () => api.changePassword({ currentPassword: current, newPassword: next }),
    onSuccess: () => {
      toast(t('app.settings.changed'));
      setCurrent('');
      setNext('');
    },
    onError: mutationError(t),
  });
  const canSubmit = current !== '' && next.length >= 8;

  return (
    <div style={{ maxWidth: 460, display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <SectionHeader title={t('app.settings.profile')} />
        <QueryBoundary query={me}>
          <div
            className="panel"
            style={{
              borderRadius: 'var(--r-md)',
              padding: 'var(--s-4)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--s-3)',
            }}
          >
            <Row label={t('app.settings.email')}>
              <span className="mono" style={{ wordBreak: 'break-all' }}>
                {me.data?.email ?? '—'}
              </span>
            </Row>
            <Row label={t('app.settings.role')}>
              {/* Show the tenant seat (管理员/成员), not the plane role (always
                  'user' for every tenant operator). null = system operator. */}
              {me.data?.tenant_role != null ? (
                <Pill tone={me.data.tenant_role === 'admin' ? 'ok' : 'idle'}>
                  {t(`app.members.roles.${me.data.tenant_role}`, me.data.tenant_role)}
                </Pill>
              ) : (
                <Pill tone="idle">{me.data?.role ?? '—'}</Pill>
              )}
            </Row>
            <Row label={t('app.settings.status')}>
              <StatusBadge
                tone={me.data?.status === 'active' ? 'ok' : 'idle'}
                label={me.data ? t('status.' + me.data.status, me.data.status) : '—'}
              />
            </Row>
            <Row label={t('app.settings.tenant')}>
              <span className="mono" style={{ wordBreak: 'break-all' }}>
                {me.data?.tenant_id ?? '—'}
              </span>
            </Row>
          </div>
        </QueryBoundary>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <SectionHeader title={t('app.settings.changePassword')} />
        <form
          className="panel"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) change.mutate();
          }}
          style={{
            borderRadius: 'var(--r-md)',
            padding: 'var(--s-4)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--s-3)',
          }}
        >
          <TextField
            type="password"
            autoComplete="current-password"
            label={t('app.settings.current')}
            value={current}
            onChange={setCurrent}
            maxLength={256}
          />
          <TextField
            type="password"
            autoComplete="new-password"
            label={t('app.settings.new')}
            value={next}
            onChange={setNext}
            minLength={8}
            maxLength={256}
            hint={t('auth.passwordPolicy')}
          />
          <Button variant="cta" type="submit" loading={change.isPending} disabled={!canSubmit}>
            {t('app.settings.submit')}
          </Button>
        </form>
      </div>
    </div>
  );
}
