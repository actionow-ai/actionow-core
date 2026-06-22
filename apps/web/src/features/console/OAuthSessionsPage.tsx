import { PlusIcon, ProhibitIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import { CopyField } from '../../components/data/CopyField';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { JsonField, validateJson } from '../../components/ui/JsonField';
import { Modal } from '../../components/ui/Modal';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { CreateOAuthSessionBody, OAuthSessionListView, SecretView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

/**
 * Operator-facing upstream OAuth credential management (`/console/oauth-sessions`).
 * Lists the registered BYO subscription sessions (token-free) and connects new
 * ones two ways: a turnkey codex login (server-side OAuth — start → authorize →
 * complete, no token pasting) and a BYO paste-auth (the operator pastes an
 * exported auth-json). Tokens are encrypted server-side and never shown.
 */
export function OAuthSessionsPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();

  const sessions = useQuery({
    queryKey: qk.oauthSessions(),
    queryFn: () => api.listOAuthSessions(),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: qk.oauthSessions() });

  // Stored encrypted credentials (provider API keys) — the other half of
  // "Credentials". Created during channel setup; revocable here.
  const secrets = useQuery({
    queryKey: qk.secrets(),
    queryFn: () => api.listSecrets(),
  });

  const [revokeTarget, setRevokeTarget] = useState<OAuthSessionListView | undefined>(undefined);
  const [secretRevokeTarget, setSecretRevokeTarget] = useState<SecretView | undefined>(undefined);

  const revokeSecret = useMutation({
    mutationFn: (id: string) => api.deleteSecret(id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.secrets() });
      toast(t('secrets.revoked'));
      setSecretRevokeTarget(undefined);
    },
    onError: mutationError(t),
  });

  // Turnkey codex login.
  const [codexOpen, setCodexOpen] = useState(false);
  const [codexTos, setCodexTos] = useState(false);
  const [authorize, setAuthorize] = useState<{ authorize_url: string; state: string } | null>(null);
  const [code, setCode] = useState('');
  const [codexLabel, setCodexLabel] = useState('');

  // BYO paste-auth.
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteTos, setPasteTos] = useState(false);
  const [authJson, setAuthJson] = useState('');
  const parsed = validateJson(authJson);

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeOAuthSession(id),
    onSuccess: async () => {
      await invalidate();
      toast(t('oauthSessions.revoked'));
      setRevokeTarget(undefined);
    },
    onError: mutationError(t),
  });

  const closeCodex = () => {
    setCodexOpen(false);
    setCodexTos(false);
    setAuthorize(null);
    setCode('');
    setCodexLabel('');
  };
  const start = useMutation({
    mutationFn: () => api.startCodexLogin({ acknowledgeUpstreamTos: true }),
    onSuccess: (r) => setAuthorize(r),
    onError: mutationError(t),
  });
  const complete = useMutation({
    mutationFn: () => {
      if (authorize === null) throw new Error('login not started');
      return api.completeCodexLogin({
        acknowledgeUpstreamTos: true,
        code: code.trim(),
        state: authorize.state,
        ...(codexLabel.trim() !== '' ? { accountLabel: codexLabel.trim() } : {}),
      });
    },
    onSuccess: async () => {
      await invalidate();
      toast(t('oauthSessions.connected'));
      closeCodex();
    },
    onError: mutationError(t),
  });

  const closePaste = () => {
    setPasteOpen(false);
    setPasteTos(false);
    setAuthJson('');
  };
  const create = useMutation({
    mutationFn: () => {
      if (!parsed.ok || parsed.value === undefined) throw new Error('invalid auth json');
      return api.createOAuthSession({
        providerKind: 'codex-oauth',
        authJson: parsed.value as CreateOAuthSessionBody['authJson'],
        acknowledgeUpstreamTos: true,
      });
    },
    onSuccess: async () => {
      await invalidate();
      toast(t('oauthSessions.connected'));
      closePaste();
    },
    onError: mutationError(t),
  });

  useSetConsoleAction(
    () => (
      <div style={{ display: 'flex', gap: 'var(--s-2)' }}>
        <Button variant="ghost" onClick={() => setPasteOpen(true)}>
          {t('oauthSessions.paste.action')}
        </Button>
        <Button variant="cta" onClick={() => setCodexOpen(true)}>
          <PlusIcon size={14} weight="bold" /> {t('oauthSessions.codex.action')}
        </Button>
      </div>
    ),
    [t],
  );

  const fmtDate = (s: string | null) => (s !== null ? new Date(s).toLocaleString() : '—');

  const cols: Column<OAuthSessionListView>[] = [
    { key: 'provider', header: t('oauthSessions.cols.provider'), cell: (r) => r.provider_kind },
    {
      key: 'account',
      header: t('oauthSessions.cols.account'),
      cell: (r) => r.account_label ?? '—',
    },
    {
      key: 'accountId',
      header: t('oauthSessions.cols.accountId'),
      cell: (r) =>
        r.account_id !== null ? (
          <code style={{ fontSize: 'var(--fs-sm)' }}>{r.account_id}</code>
        ) : (
          '—'
        ),
    },
    {
      key: 'status',
      header: t('oauthSessions.cols.status'),
      cell: (r) => (
        <StatusBadge tone={statusTone(r.status)} label={t('status.' + r.status, r.status)} />
      ),
      width: '120px',
    },
    {
      key: 'expires',
      header: t('oauthSessions.cols.expires'),
      cell: (r) => fmtDate(r.expires_at),
      width: '170px',
    },
    {
      key: 'refresh',
      header: t('oauthSessions.cols.lastRefresh'),
      cell: (r) => fmtDate(r.last_refresh_at),
      width: '170px',
    },
  ];

  const secretCols: Column<SecretView>[] = [
    {
      key: 'id',
      header: t('secrets.cols.id'),
      cell: (r) => <code style={{ fontSize: 'var(--fs-sm)' }}>{r.id}</code>,
    },
    { key: 'provider', header: t('secrets.cols.provider'), cell: (r) => r.provider },
    {
      key: 'created',
      header: t('secrets.cols.created'),
      cell: (r) => fmtDate(r.created_at),
      width: '170px',
    },
  ];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
      <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <SectionHeader title={t('oauthSessions.title')} />
        <DataTable
          columns={cols}
          rows={sessions.data ?? []}
          rowKey={(r) => r.id}
          loading={sessions.isLoading}
          error={sessions.isError}
          onRetry={() => void sessions.refetch()}
          empty={t('oauthSessions.empty')}
          rowActions={(r) => (
            <Button variant="ghost" size="sm" onClick={() => setRevokeTarget(r)}>
              <ProhibitIcon size={14} /> {t('oauthSessions.revoke')}
            </Button>
          )}
          actionsWidth="120px"
          searchable
          pageSize={20}
        />
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <SectionHeader title={t('secrets.title')} />
        <DataTable
          columns={secretCols}
          rows={secrets.data ?? []}
          rowKey={(r) => r.id}
          loading={secrets.isLoading}
          error={secrets.isError}
          onRetry={() => void secrets.refetch()}
          empty={t('secrets.empty')}
          rowActions={(r) => (
            <Button variant="ghost" size="sm" onClick={() => setSecretRevokeTarget(r)}>
              <ProhibitIcon size={14} /> {t('secrets.revoke')}
            </Button>
          )}
          actionsWidth="120px"
          searchable
          pageSize={20}
        />
      </section>

      <Modal
        open={codexOpen}
        title={t('oauthSessions.codex.title')}
        subtitle={t('oauthSessions.codex.subtitle')}
        onClose={closeCodex}
        footer={
          authorize === null ? (
            <Button
              variant="cta"
              onClick={() => start.mutate()}
              loading={start.isPending}
              disabled={!codexTos}
            >
              {t('oauthSessions.codex.start')}
            </Button>
          ) : (
            <Button
              variant="cta"
              onClick={() => complete.mutate()}
              loading={complete.isPending}
              disabled={code.trim() === ''}
            >
              {t('oauthSessions.codex.complete')}
            </Button>
          )
        }
      >
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--run)' }}>
          {t('oauthSessions.tosWarn')}
        </div>
        {authorize === null ? (
          <Checkbox checked={codexTos} onChange={setCodexTos} label={t('oauthSessions.tosAck')} />
        ) : (
          <>
            <div style={{ fontSize: 'var(--fs-sm)' }}>{t('oauthSessions.codex.openHint')}</div>
            <CopyField
              value={authorize.authorize_url}
              copyLabel={t('oauthSessions.codex.copyUrl')}
              copiedLabel={t('oauthSessions.copied')}
            />
            <a
              href={authorize.authorize_url}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 'var(--fs-sm)' }}
            >
              {t('oauthSessions.codex.openLink')}
            </a>
            <TextField label={t('oauthSessions.codex.code')} value={code} onChange={setCode} />
            <TextField
              label={t('oauthSessions.codex.label')}
              hint={t('oauthSessions.codex.labelHint')}
              value={codexLabel}
              onChange={setCodexLabel}
            />
          </>
        )}
      </Modal>

      <Modal
        open={pasteOpen}
        title={t('oauthSessions.paste.title')}
        subtitle={t('oauthSessions.paste.subtitle')}
        onClose={closePaste}
        footer={
          <Button
            variant="cta"
            onClick={() => create.mutate()}
            loading={create.isPending}
            disabled={!pasteTos || !parsed.ok || parsed.value === undefined}
          >
            {t('oauthSessions.paste.submit')}
          </Button>
        }
      >
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--run)' }}>
          {t('oauthSessions.tosWarn')}
        </div>
        <JsonField
          label={t('oauthSessions.paste.authJson')}
          value={authJson}
          onChange={setAuthJson}
          error={!parsed.ok ? parsed.error : undefined}
          placeholder='{"access_token":"…","refresh_token":"…"}'
        />
        <Checkbox checked={pasteTos} onChange={setPasteTos} label={t('oauthSessions.tosAck')} />
      </Modal>

      <ConfirmDialog
        open={revokeTarget !== undefined}
        title={t('oauthSessions.confirmRevokeTitle')}
        message={t('oauthSessions.confirmRevokeMsg', {
          account: revokeTarget?.account_label ?? revokeTarget?.id ?? '',
        })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        danger
        loading={revoke.isPending}
        onConfirm={() => {
          if (revokeTarget) revoke.mutate(revokeTarget.id);
        }}
        onClose={() => setRevokeTarget(undefined)}
      />

      <ConfirmDialog
        open={secretRevokeTarget !== undefined}
        title={t('secrets.confirmRevokeTitle')}
        message={t('secrets.confirmRevokeMsg', {
          provider: secretRevokeTarget?.provider ?? secretRevokeTarget?.id ?? '',
        })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        danger
        loading={revokeSecret.isPending}
        onConfirm={() => {
          if (secretRevokeTarget !== undefined) revokeSecret.mutate(secretRevokeTarget.id);
        }}
        onClose={() => setSecretRevokeTarget(undefined)}
      />
    </div>
  );
}
