import { useMutation, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

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
            <Pill tone="idle">{me.data?.role ?? '—'}</Pill>
          </Row>
          <Row label={t('app.settings.status')}>
            <Pill tone={me.data?.status === 'active' ? 'ok' : 'idle'}>
              {me.data?.status ?? '—'}
            </Pill>
          </Row>
          <Row label={t('app.settings.tenant')}>
            <span className="mono" style={{ wordBreak: 'break-all' }}>
              {me.data?.tenant_id ?? '—'}
            </span>
          </Row>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <SectionHeader title={t('app.settings.changePassword')} />
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
          <TextField
            type="password"
            label={t('app.settings.current')}
            value={current}
            onChange={setCurrent}
            maxLength={256}
          />
          <TextField
            type="password"
            label={t('app.settings.new')}
            value={next}
            onChange={setNext}
            minLength={8}
            maxLength={256}
            hint={t('auth.passwordPolicy')}
          />
          <Button
            variant="cta"
            onClick={() => change.mutate()}
            loading={change.isPending}
            disabled={!canSubmit}
          >
            {t('app.settings.submit')}
          </Button>
        </div>
      </div>
    </div>
  );
}
