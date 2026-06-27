import { PencilSimpleIcon, PlusIcon, ProhibitIcon } from '@phosphor-icons/react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import { CopyField } from '../../components/data/CopyField';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { LoadMore } from '../../components/data/LoadMore';
import { ProviderIcon } from '../../components/data/ProviderIcon';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Drawer } from '../../components/ui/Drawer';
import { JsonField, validateJson } from '../../components/ui/JsonField';
import { Modal } from '../../components/ui/Modal';
import { RowAction } from '../../components/ui/RowAction';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type {
  CreateOAuthSessionBody,
  OAuthSessionListView,
  SecretView,
  UpdateCredentialMetaBody,
} from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { useUrlState } from '../../lib/useUrlState';

type CredTab = 'oauth' | 'secrets';
type EditTarget =
  | { kind: 'oauth'; id: string; name: string; notes: string; group: string }
  | { kind: 'secret'; id: string; name: string; notes: string; group: string };

/**
 * Operator-facing upstream credential management (`/console/oauth-sessions`, under
 * the「接入与供给」group). Two credential kinds live behind a sub-tab strip: BYO
 * OAuth subscription sessions and stored API-key secrets. Each carries editable
 * operator metadata (name/notes/group) and supports edit / revoke / bulk-revoke.
 * Tokens + secret material are encrypted server-side and never shown.
 */
export function OAuthSessionsPage() {
  const { t, i18n } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  const [tab, setTab] = useUrlState('ctab', 'oauth');
  const active: CredTab = tab === 'secrets' ? 'secrets' : 'oauth';

  const sessions = useInfiniteQuery({
    queryKey: qk.oauthSessions(),
    queryFn: ({ pageParam }) => api.listOAuthSessions({ cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const sessionRows = sessions.data?.pages.flatMap((p) => p.rows) ?? [];
  const invalidateSessions = () => qc.invalidateQueries({ queryKey: qk.oauthSessions() });

  // Stored encrypted credentials (provider API keys) — now keyset-paginated too.
  const secrets = useInfiniteQuery({
    queryKey: qk.secrets(),
    queryFn: ({ pageParam }) => api.listSecretsPage({ cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const secretRows = secrets.data?.pages.flatMap((p) => p.rows) ?? [];
  const invalidateSecrets = () => qc.invalidateQueries({ queryKey: qk.secrets() });

  const [revokeTarget, setRevokeTarget] = useState<OAuthSessionListView | undefined>(undefined);
  const [secretRevokeTarget, setSecretRevokeTarget] = useState<SecretView | undefined>(undefined);
  const [editing, setEditing] = useState<EditTarget | null>(null);

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeOAuthSession(id),
    onSuccess: async () => {
      await invalidateSessions();
      toast(t('oauthSessions.revoked'));
      setRevokeTarget(undefined);
    },
    onError: mutationError(t),
  });
  const revokeSecret = useMutation({
    mutationFn: (id: string) => api.deleteSecret(id),
    onSuccess: async () => {
      await invalidateSecrets();
      toast(t('secrets.revoked'));
      setSecretRevokeTarget(undefined);
    },
    onError: mutationError(t),
  });

  // Metadata edit (name/notes/group) — never the token/secret material.
  const saveEdit = useMutation({
    mutationFn: async (): Promise<void> => {
      if (editing === null) throw new Error('not editing');
      const body: UpdateCredentialMetaBody = {
        name: editing.name.trim() === '' ? null : editing.name.trim(),
        notes: editing.notes.trim() === '' ? null : editing.notes.trim(),
        group: editing.group.trim() === '' ? null : editing.group.trim(),
      };
      if (editing.kind === 'oauth') await api.updateOAuthSession(editing.id, body);
      else await api.updateSecret(editing.id, body);
    },
    onSuccess: async () => {
      await (editing?.kind === 'secret' ? invalidateSecrets() : invalidateSessions());
      toast(t('credentials.saved'));
      setEditing(null);
    },
    onError: mutationError(t),
  });

  // Bulk revoke. OAuth sessions go through ONE `/admin/oauth-sessions/bulk` call
  // (partial success → succeeded/failed counts in the toast). Secrets have no bulk
  // endpoint yet, so they keep the allSettled fan-out (one failure doesn't abort
  // the rest) until one lands.
  const bulkRevoke = async (ids: string[], kind: CredTab, clear: () => void) => {
    if (kind === 'oauth') {
      const r = await api.bulkRevokeOAuthSessions(ids);
      await invalidateSessions();
      toast(t('admin.bulk.result', { ok: r.succeeded.length, failed: r.failed.length }));
      clear();
      return;
    }
    await Promise.allSettled(ids.map((id) => api.deleteSecret(id)));
    await invalidateSecrets();
    toast(t('credentials.bulkRevoked', { n: ids.length }));
    clear();
  };

  // --- codex login + paste-auth (unchanged create flows) ---
  const [codexOpen, setCodexOpen] = useState(false);
  const [codexTos, setCodexTos] = useState(false);
  const [authorize, setAuthorize] = useState<{ authorize_url: string; state: string } | null>(null);
  const [code, setCode] = useState('');
  const [codexLabel, setCodexLabel] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteTos, setPasteTos] = useState(false);
  const [authJson, setAuthJson] = useState('');
  const parsed = validateJson(authJson);

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
      await invalidateSessions();
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
      await invalidateSessions();
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

  const fmtDate = (s: string | null) =>
    s !== null ? new Date(s).toLocaleString(i18n.language) : '—';

  const metaCols = <
    T extends { name: string | null; notes: string | null; group: string | null },
  >(): Column<T>[] => [
    {
      key: 'name',
      header: t('credentials.name'),
      width: '180px',
      cell: (r) => r.name ?? <span style={{ color: 'var(--faint)' }}>—</span>,
    },
    {
      key: 'group',
      header: t('credentials.group'),
      noClip: true,
      cell: (r) =>
        r.group !== null ? (
          <span className="chip">{r.group}</span>
        ) : (
          <span style={{ color: 'var(--faint)' }}>—</span>
        ),
      width: '120px',
    },
  ];

  const cols: Column<OAuthSessionListView>[] = [
    ...metaCols<OAuthSessionListView>().slice(0, 1),
    {
      key: 'provider',
      header: t('oauthSessions.cols.provider'),
      noClip: true,
      cell: (r) => (
        <span
          style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-2)', minWidth: 0 }}
        >
          <ProviderIcon provider={r.provider_kind} size={16} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.provider_kind}</span>
        </span>
      ),
      width: '160px',
    },
    // account is the elastic column.
    {
      key: 'account',
      header: t('oauthSessions.cols.account'),
      grow: true,
      cell: (r) => r.account_label ?? '—',
    },
    ...metaCols<OAuthSessionListView>().slice(1),
    {
      key: 'status',
      header: t('oauthSessions.cols.status'),
      noClip: true,
      cell: (r) => (
        <StatusBadge tone={statusTone(r.status)} label={t('status.' + r.status, r.status)} />
      ),
      width: '148px',
    },
    {
      key: 'expires',
      header: t('oauthSessions.cols.expires'),
      cell: (r) => fmtDate(r.expires_at),
      align: 'right',
      width: '170px',
    },
  ];

  const secretCols: Column<SecretView>[] = [
    ...metaCols<SecretView>().slice(0, 1),
    {
      key: 'provider',
      header: t('secrets.cols.provider'),
      noClip: true,
      cell: (r) => (
        <span
          style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-2)', minWidth: 0 }}
        >
          <ProviderIcon provider={r.provider} size={16} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.provider}</span>
        </span>
      ),
      width: '160px',
    },
    // The copy-field id is the elastic column and must never be ellipsis-clipped.
    {
      key: 'id',
      header: t('secrets.cols.id'),
      grow: true,
      noClip: true,
      cell: (r) => (
        <CopyField
          value={r.id}
          copyLabel={t('common.copy')}
          copiedLabel={t('common.copied')}
          failedLabel={t('common.copyFailed')}
        />
      ),
    },
    ...metaCols<SecretView>().slice(1),
    {
      key: 'created',
      header: t('secrets.cols.created'),
      cell: (r) => fmtDate(r.created_at),
      align: 'right',
      width: '170px',
    },
  ];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
      <SegmentedControl
        ariaLabel={t('credentials.tabsLabel')}
        value={active}
        onChange={setTab}
        options={[
          { value: 'oauth', label: t('oauthSessions.title') },
          { value: 'secrets', label: t('secrets.title') },
        ]}
      />

      {active === 'oauth' ? (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
          <DataTable
            columns={cols}
            rows={sessionRows}
            rowKey={(r) => r.id}
            loading={sessions.isLoading}
            error={sessions.isError}
            onRetry={() => void sessions.refetch()}
            empty={t('oauthSessions.empty')}
            selectable
            actionsWidth="96px"
            bulkActions={(rows, clear) => (
              <Button
                variant="ghost"
                onClick={() =>
                  void bulkRevoke(
                    rows.map((r) => r.id),
                    'oauth',
                    clear,
                  )
                }
              >
                {t('credentials.bulkRevoke', { n: rows.length })}
              </Button>
            )}
            rowActions={(r) => (
              <>
                <RowAction
                  icon={PencilSimpleIcon}
                  label={t('credentials.edit')}
                  onClick={() =>
                    setEditing({
                      kind: 'oauth',
                      id: r.id,
                      name: r.name ?? '',
                      notes: r.notes ?? '',
                      group: r.group ?? '',
                    })
                  }
                />
                <RowAction
                  icon={ProhibitIcon}
                  label={t('oauthSessions.revoke')}
                  danger
                  onClick={() => setRevokeTarget(r)}
                />
              </>
            )}
          />
          <LoadMore
            hasNextPage={sessions.hasNextPage}
            isFetchingNextPage={sessions.isFetchingNextPage}
            onLoadMore={() => void sessions.fetchNextPage()}
          />
        </section>
      ) : (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
          <DataTable
            columns={secretCols}
            rows={secretRows}
            rowKey={(r) => r.id}
            loading={secrets.isLoading}
            error={secrets.isError}
            onRetry={() => void secrets.refetch()}
            empty={t('secrets.empty')}
            selectable
            actionsWidth="96px"
            bulkActions={(rows, clear) => (
              <Button
                variant="ghost"
                onClick={() =>
                  void bulkRevoke(
                    rows.map((r) => r.id),
                    'secrets',
                    clear,
                  )
                }
              >
                {t('credentials.bulkRevoke', { n: rows.length })}
              </Button>
            )}
            rowActions={(r) => (
              <>
                <RowAction
                  icon={PencilSimpleIcon}
                  label={t('credentials.edit')}
                  onClick={() =>
                    setEditing({
                      kind: 'secret',
                      id: r.id,
                      name: r.name ?? '',
                      notes: r.notes ?? '',
                      group: r.group ?? '',
                    })
                  }
                />
                <RowAction
                  icon={ProhibitIcon}
                  label={t('secrets.revoke')}
                  danger
                  onClick={() => setSecretRevokeTarget(r)}
                />
              </>
            )}
          />
          <LoadMore
            hasNextPage={secrets.hasNextPage}
            isFetchingNextPage={secrets.isFetchingNextPage}
            onLoadMore={() => void secrets.fetchNextPage()}
          />
        </section>
      )}

      {/* Metadata edit drawer (name/notes/group) */}
      <Drawer
        open={editing !== null}
        title={t('credentials.editTitle')}
        onClose={() => setEditing(null)}
        footer={
          <div style={{ display: 'flex', gap: 'var(--s-2)', justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="cta" onClick={() => saveEdit.mutate()} loading={saveEdit.isPending}>
              {t('common.save')}
            </Button>
          </div>
        }
      >
        {editing !== null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
            <TextField
              label={t('credentials.name')}
              value={editing.name}
              onChange={(v) => setEditing({ ...editing, name: v })}
            />
            <TextField
              label={t('credentials.group')}
              hint={t('credentials.groupHint')}
              value={editing.group}
              onChange={(v) => setEditing({ ...editing, group: v })}
            />
            <TextField
              label={t('credentials.notes')}
              value={editing.notes}
              onChange={(v) => setEditing({ ...editing, notes: v })}
            />
          </div>
        )}
      </Drawer>

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
          account: revokeTarget?.name ?? revokeTarget?.account_label ?? revokeTarget?.id ?? '',
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
          provider:
            secretRevokeTarget?.name ??
            secretRevokeTarget?.provider ??
            secretRevokeTarget?.id ??
            '',
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
