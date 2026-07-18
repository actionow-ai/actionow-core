import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pencil, Play, Power, Radar, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';

import { apiFetch, toApiStateError } from '@/api/client';
import { useCursorQuery } from '@/api/hooks';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DateTimeText } from '@/components/common/date-time-text';
import { DetailList } from '@/components/common/detail-list';
import { FormField } from '@/components/common/form-field';
import { LoadMore } from '@/components/common/load-more';
import { ApiErrorNotice, ResourceLoading } from '@/components/shell/api-state';
import { PageHeader, PageTransition } from '@/components/shell/page';
import { Button } from '@/components/ui/components/buttons/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/components/radix/dialog';
import {
  Badge,
  Card,
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from '@/components/ui/data-display';
import { PlusIcon } from '@/components/ui/icons/plus';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type AuthScheme = 'bearer' | 'x_api_key' | 'query' | 'ak_sk' | 'oauth';
type ChannelStatus = 'active' | 'disabled';
type CredentialStatus = 'active' | 'disabled';
type PricingStatus = 'existing' | 'minted' | 'needs_pricing';

interface DialectRef {
  ref: string;
  version: string;
}

interface ChannelRow {
  id: string;
  provider_id: string;
  name: string;
  dialect: DialectRef | null;
  base_url: string | null;
  proxy_ref: string | null;
  region: string | null;
  auth_scheme: AuthScheme;
  tenant_id: string | null;
  route_group_id: string | null;
  tags: string[];
  status: ChannelStatus;
  created_at: string;
  updated_at: string;
}

interface ProviderRow {
  id: string;
  name: string;
  default_dialect: DialectRef;
}

interface QuotaMirror {
  rpm: number | null;
  tpm: number | null;
  max_concurrency: number | null;
}

interface CredentialRow {
  id: string;
  channel_id: string;
  name: string;
  secret_hint: string | null;
  quota: QuotaMirror;
  status: CredentialStatus;
  cooldown_until: string | null;
  created_at: string;
  updated_at: string;
}

interface ModelRow {
  id: string;
  name: string;
  display_name: string;
}

interface DiscoveredModel {
  upstream_model_name: string;
  display_name?: string;
  source: 'dialect_discovery' | 'catalog';
  exists_as_offering: boolean;
}

interface DiscoverResponse {
  source: 'dialect_discovery' | 'catalog';
  models: DiscoveredModel[];
}

interface BatchItem {
  upstream_model_name: string;
  model_id?: string;
  new_model?: { name: string };
}

interface BatchCreatedOffering {
  offering: { id: string; status: string };
  model_id: string;
  upstream_model_name: string;
  pricing: { status: PricingStatus; price_card_id?: string; message?: string };
}

interface BatchResponse {
  offerings: BatchCreatedOffering[];
  needs_pricing_count: number;
}

interface ProbeEnableResult {
  offering_id: string;
  upstream_model_name: string;
  enabled: boolean;
  offering_status: string;
  violations: { gate: string; param?: string; message: string }[];
}

interface ProbeEnableResponse {
  results: ProbeEnableResult[];
  enabled_count: number;
}

interface ChannelEditForm {
  name: string;
  authScheme: AuthScheme;
  baseUrl: string;
  region: string;
  tags: string;
  routeGroupId: string;
  status: ChannelStatus;
}

interface CredentialForm {
  name: string;
  apiKey: string;
  accessKey: string;
  secretKey: string;
  signingRegion: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken: string;
  rpm: string;
  tpm: string;
  maxConcurrency: string;
}

interface CredentialCreateBody {
  channel_id: string;
  name: string;
  secret: Record<string, string>;
  quota?: QuotaMirror;
}

interface RowSelection {
  checked: boolean;
  modelChoice: string;
  newName: string;
}

const AUTH_SCHEMES: AuthScheme[] = ['bearer', 'x_api_key', 'query', 'ak_sk', 'oauth'];
const NEW_MODEL = '__new__';

const statusVariant = { active: 'success', disabled: 'danger' } as const;
const pricingVariant = {
  existing: 'neutral',
  minted: 'success',
  needs_pricing: 'warning',
} as const;

const emptyCredentialForm: CredentialForm = {
  name: '',
  apiKey: '',
  accessKey: '',
  secretKey: '',
  signingRegion: '',
  clientId: '',
  clientSecret: '',
  refreshToken: '',
  accessToken: '',
  rpm: '',
  tpm: '',
  maxConcurrency: '',
};

function parseQuotaField(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
}

function quotaText(quota: QuotaMirror): string {
  const part = (value: number | null) => (value === null ? '—' : String(value));
  return `${part(quota.rpm)} / ${part(quota.tpm)} / ${part(quota.max_concurrency)}`;
}

function ProbeResults({ result }: { result: ProbeEnableResponse }) {
  const { t } = useTranslation();
  return (
    <div>
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">{t('supplySources.probeResultTitle')}</h3>
        <Badge variant={result.enabled_count > 0 ? 'success' : 'warning'}>
          {t('supplySources.enabledSummary', { count: result.enabled_count })}
        </Badge>
      </div>
      <ul className="mt-2 divide-y divide-border/60">
        {result.results.map((row) => (
          <li key={row.offering_id} className="py-2.5">
            <div className="flex items-center justify-between gap-4">
              <span className="min-w-0 truncate font-mono text-sm">{row.upstream_model_name}</span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">
                  {row.offering_status}
                </span>
                <Badge variant={row.enabled ? 'success' : 'danger'}>
                  {row.enabled
                    ? t('supplySources.enabledBadge')
                    : t('supplySources.notEnabledBadge')}
                </Badge>
              </span>
            </div>
            {row.violations.length > 0 ? (
              <ul className="mt-1 space-y-0.5">
                {row.violations.map((violation, index) => (
                  <li key={index} className="text-xs text-muted-foreground">
                    <span className="font-mono">{violation.gate}</span>
                    {violation.param !== undefined ? (
                      <span className="font-mono">{` · ${violation.param}`}</span>
                    ) : null}
                    {` — ${violation.message}`}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ChannelDetailPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const params = useParams<{ id: string }>();
  const channelId = params.id ?? '';

  const channel = useQuery({
    queryKey: ['admin', 'supply', 'channel', channelId],
    queryFn: () => apiFetch<ChannelRow>(`/admin/supply/channels/${channelId}`),
    enabled: channelId !== '',
  });
  const providerId = channel.data?.provider_id;
  const provider = useQuery({
    queryKey: ['admin', 'supply', 'provider', providerId],
    queryFn: () => apiFetch<ProviderRow>(`/admin/supply/providers/${providerId ?? ''}`),
    enabled: providerId !== undefined,
  });
  const credentials = useCursorQuery<CredentialRow>({
    key: ['admin', 'supply', 'credentials'],
    path: '/admin/supply/credentials',
    query: { channel_id: channelId },
    enabled: channelId !== '',
  });

  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<ChannelEditForm | null>(null);
  const [credOpen, setCredOpen] = useState(false);
  const [credForm, setCredForm] = useState<CredentialForm>(emptyCredentialForm);
  const [credDeleting, setCredDeleting] = useState<CredentialRow | null>(null);

  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoverResponse | null>(null);
  const [selections, setSelections] = useState<Record<string, RowSelection>>({});
  const [batchResult, setBatchResult] = useState<BatchResponse | null>(null);
  const [probeResult, setProbeResult] = useState<ProbeEnableResponse | null>(null);
  const [cardProbeResult, setCardProbeResult] = useState<ProbeEnableResponse | null>(null);

  const models = useCursorQuery<ModelRow>({
    key: ['admin', 'supply', 'models'],
    path: '/admin/supply/models',
    limit: 100,
    enabled: discoverOpen,
  });

  const invalidateChannel = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'supply', 'channel', channelId] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'supply', 'channels'] });
  };
  const invalidateCredentials = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'supply', 'credentials'] });
  };

  const updateChannel = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch<ChannelRow>(`/admin/supply/channels/${channelId}`, { method: 'PATCH', body }),
    onSuccess: () => {
      invalidateChannel();
      setEditOpen(false);
    },
  });

  const createCredential = useMutation({
    mutationFn: (body: CredentialCreateBody) =>
      apiFetch<CredentialRow>('/admin/supply/credentials', { method: 'POST', body }),
    onSuccess: () => {
      invalidateCredentials();
      setCredOpen(false);
    },
  });

  const toggleCredential = useMutation({
    mutationFn: (input: { id: string; status: CredentialStatus }) =>
      apiFetch<CredentialRow>(`/admin/supply/credentials/${input.id}`, {
        method: 'PATCH',
        body: { status: input.status },
      }),
    onSuccess: invalidateCredentials,
  });

  const deleteCredential = useMutation({
    mutationFn: (id: string) =>
      apiFetch<unknown>(`/admin/supply/credentials/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidateCredentials();
      setCredDeleting(null);
    },
  });

  const discoverMutation = useMutation({
    mutationFn: () =>
      apiFetch<DiscoverResponse>(`/admin/supply/channels/${channelId}/discover`, {
        method: 'POST',
      }),
    onSuccess: (response) => {
      setDiscovered(response);
      const next: Record<string, RowSelection> = {};
      for (const model of response.models) {
        next[model.upstream_model_name] = {
          checked: false,
          modelChoice: NEW_MODEL,
          newName: model.upstream_model_name,
        };
      }
      setSelections(next);
      setBatchResult(null);
      setProbeResult(null);
      setDiscoverOpen(true);
    },
  });

  const batchMutation = useMutation({
    mutationFn: (items: BatchItem[]) =>
      apiFetch<BatchResponse>(`/admin/supply/channels/${channelId}/offerings/batch`, {
        method: 'POST',
        body: { items },
      }),
    onSuccess: (response) => {
      setBatchResult(response);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'supply', 'models'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'supply', 'offerings'] });
    },
  });

  const probeMutation = useMutation({
    mutationFn: (offeringIds?: string[]) =>
      apiFetch<ProbeEnableResponse>(
        `/admin/supply/channels/${channelId}/offerings/probe-and-enable`,
        { method: 'POST', body: offeringIds ? { offering_ids: offeringIds } : {} },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'supply', 'offerings'] });
    },
  });

  const openEdit = () => {
    const data = channel.data;
    if (!data) return;
    setEditForm({
      name: data.name,
      authScheme: data.auth_scheme,
      baseUrl: data.base_url ?? '',
      region: data.region ?? '',
      tags: data.tags.join(', '),
      routeGroupId: data.route_group_id ?? '',
      status: data.status,
    });
    updateChannel.reset();
    setEditOpen(true);
  };

  const openCreateCredential = () => {
    setCredForm(emptyCredentialForm);
    createCredential.reset();
    setCredOpen(true);
  };

  const scheme = channel.data?.auth_scheme ?? 'bearer';

  const buildSecret = (): Record<string, string> => {
    const secret: Record<string, string> = { scheme };
    if (scheme === 'ak_sk') {
      secret.access_key = credForm.accessKey.trim();
      secret.secret_key = credForm.secretKey.trim();
      if (credForm.signingRegion.trim() !== '') secret.region = credForm.signingRegion.trim();
    } else if (scheme === 'oauth') {
      if (credForm.clientId.trim() !== '') secret.client_id = credForm.clientId.trim();
      if (credForm.clientSecret.trim() !== '') secret.client_secret = credForm.clientSecret.trim();
      if (credForm.refreshToken.trim() !== '') secret.refresh_token = credForm.refreshToken.trim();
      if (credForm.accessToken.trim() !== '') secret.access_token = credForm.accessToken.trim();
    } else {
      secret.api_key = credForm.apiKey.trim();
    }
    return secret;
  };

  const canCreateCredential =
    credForm.name.trim() !== '' &&
    (scheme === 'oauth'
      ? true
      : scheme === 'ak_sk'
        ? credForm.accessKey.trim() !== '' && credForm.secretKey.trim() !== ''
        : credForm.apiKey.trim() !== '');

  const submitCredential = () => {
    const rpm = parseQuotaField(credForm.rpm);
    const tpm = parseQuotaField(credForm.tpm);
    const maxConcurrency = parseQuotaField(credForm.maxConcurrency);
    const body: CredentialCreateBody = {
      channel_id: channelId,
      name: credForm.name.trim(),
      secret: buildSecret(),
    };
    if (rpm !== null || tpm !== null || maxConcurrency !== null) {
      body.quota = { rpm, tpm, max_concurrency: maxConcurrency };
    }
    createCredential.mutate(body);
  };

  const pickedModels = (discovered?.models ?? []).filter(
    (model) => !model.exists_as_offering && selections[model.upstream_model_name]?.checked,
  );
  const pickedValid = pickedModels.every((model) => {
    const selection = selections[model.upstream_model_name];
    if (!selection) return false;
    return selection.modelChoice !== NEW_MODEL || selection.newName.trim() !== '';
  });
  const canCreateOfferings = pickedModels.length > 0 && pickedValid;

  const submitBatch = () => {
    const items: BatchItem[] = pickedModels.map((model) => {
      const selection = selections[model.upstream_model_name];
      if (selection && selection.modelChoice !== NEW_MODEL) {
        return { upstream_model_name: model.upstream_model_name, model_id: selection.modelChoice };
      }
      return {
        upstream_model_name: model.upstream_model_name,
        new_model: { name: selection?.newName.trim() ?? '' },
      };
    });
    batchMutation.mutate(items);
  };

  const updateSelection = (name: string, patch: Partial<RowSelection>) => {
    setSelections((current) => {
      const existing = current[name] ?? { checked: false, modelChoice: NEW_MODEL, newName: name };
      return { ...current, [name]: { ...existing, ...patch } };
    });
  };

  const data = channel.data;
  const now = Date.now();

  return (
    <PageTransition>
      <PageHeader
        title={data?.name ?? t('supplySources.channelDetailFallbackTitle')}
        description={t('supplySources.channelDetailDescription')}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/console/supply/channels">
                <ArrowLeft />
                {t('supplySources.backToChannels')}
              </Link>
            </Button>
            <Button onClick={openEdit} disabled={!data}>
              <Pencil />
              {t('supplySources.editChannel')}
            </Button>
          </>
        }
      />

      {channel.isLoading ? (
        <ResourceLoading rows={6} />
      ) : channel.isError ? (
        <ApiErrorNotice
          error={toApiStateError(channel.error)}
          onRetry={() => void channel.refetch()}
        />
      ) : data ? (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <h2 className="mb-3 text-sm font-semibold">{t('supplySources.infoTitle')}</h2>
              <DetailList
                items={[
                  {
                    label: t('common.status'),
                    value: (
                      <Badge variant={statusVariant[data.status]}>
                        {data.status === 'active' ? t('common.active') : t('common.disabled')}
                      </Badge>
                    ),
                  },
                  {
                    label: t('supplySources.labelProvider'),
                    value: provider.data?.name ?? data.provider_id.slice(0, 8),
                  },
                  {
                    label: t('supplySources.labelDialect'),
                    value: data.dialect ? (
                      <span className="font-mono">{`${data.dialect.ref}@${data.dialect.version}`}</span>
                    ) : provider.data ? (
                      <span className="text-muted-foreground">
                        {`${t('supplySources.dialectInherited')} · ${provider.data.default_dialect.ref}@${provider.data.default_dialect.version}`}
                      </span>
                    ) : (
                      t('supplySources.dialectInherited')
                    ),
                  },
                  {
                    label: t('supplySources.labelAuthScheme'),
                    value: <span className="font-mono">{data.auth_scheme}</span>,
                  },
                  {
                    label: t('supplySources.labelBaseUrl'),
                    value: data.base_url ? <span className="font-mono">{data.base_url}</span> : '—',
                  },
                  { label: t('supplySources.labelRegion'), value: data.region ?? '—' },
                  {
                    label: t('supplySources.labelTags'),
                    value:
                      data.tags.length === 0 ? (
                        '—'
                      ) : (
                        <span className="inline-flex flex-wrap justify-end gap-1">
                          {data.tags.map((tag) => (
                            <Badge key={tag} variant="neutral">
                              {tag}
                            </Badge>
                          ))}
                        </span>
                      ),
                  },
                  {
                    label: t('supplySources.labelRouteGroup'),
                    value: data.route_group_id ? (
                      <span className="font-mono">{data.route_group_id}</span>
                    ) : (
                      '—'
                    ),
                  },
                  {
                    label: t('supplySources.labelProxy'),
                    value: data.proxy_ref ? (
                      <span className="font-mono">{data.proxy_ref}</span>
                    ) : (
                      '—'
                    ),
                  },
                  {
                    label: t('supplySources.labelOwner'),
                    value: data.tenant_id ? (
                      <Badge variant="primary">
                        {`${t('supplySources.byok')} · ${data.tenant_id.slice(0, 8)}`}
                      </Badge>
                    ) : (
                      t('supplySources.ownerPlatform')
                    ),
                  },
                  {
                    label: t('common.createdAt'),
                    value: <DateTimeText value={data.created_at} />,
                  },
                  {
                    label: t('common.updatedAt'),
                    value: <DateTimeText value={data.updated_at} />,
                  },
                ]}
              />
            </Card>

            <Card className="p-5">
              <h2 className="text-sm font-semibold">{t('supplySources.onboardTitle')}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('supplySources.onboardDescription')}
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button
                  onClick={() => discoverMutation.mutate()}
                  disabled={discoverMutation.isPending}
                >
                  <Radar />
                  {discoverMutation.isPending
                    ? t('supplySources.discovering')
                    : t('supplySources.discover')}
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    probeMutation.mutate(undefined, {
                      onSuccess: (response) => setCardProbeResult(response),
                    })
                  }
                  disabled={probeMutation.isPending}
                >
                  <Play />
                  {probeMutation.isPending
                    ? t('supplySources.probing')
                    : t('supplySources.probeAndEnable')}
                </Button>
              </div>
              {discoverMutation.isError ? (
                <p className="mt-3 text-sm text-danger">
                  {toApiStateError(discoverMutation.error).message}
                </p>
              ) : null}
              {probeMutation.isError ? (
                <p className="mt-3 text-sm text-danger">
                  {toApiStateError(probeMutation.error).message}
                </p>
              ) : null}
              {cardProbeResult ? (
                <div className="mt-4">
                  <ProbeResults result={cardProbeResult} />
                </div>
              ) : null}
            </Card>
          </div>

          <Card className="mt-4 p-5">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold">{t('supplySources.credentialsTitle')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('supplySources.credentialsDescription')}
                </p>
              </div>
              <Button onClick={openCreateCredential}>
                <PlusIcon animateOnHover />
                {t('supplySources.newCredential')}
              </Button>
            </div>
            {credentials.isLoading ? (
              <ResourceLoading rows={3} />
            ) : credentials.isError ? (
              <ApiErrorNotice
                error={toApiStateError(credentials.error)}
                onRetry={() => void credentials.refetch()}
              />
            ) : credentials.rows.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t('supplySources.credentialsEmpty')}
              </p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <DataTable className="min-w-full">
                    <DataTableHeader>
                      <DataTableRow>
                        <DataTableHead>{t('common.name')}</DataTableHead>
                        <DataTableHead>{t('supplySources.colSecretHint')}</DataTableHead>
                        <DataTableHead>{t('common.status')}</DataTableHead>
                        <DataTableHead>{t('supplySources.colQuota')}</DataTableHead>
                        <DataTableHead>{t('supplySources.colCooldown')}</DataTableHead>
                        <DataTableHead className="text-right">{t('common.actions')}</DataTableHead>
                      </DataTableRow>
                    </DataTableHeader>
                    <DataTableBody>
                      {credentials.rows.map((row) => {
                        const cooling =
                          row.cooldown_until !== null &&
                          new Date(row.cooldown_until).getTime() > now;
                        return (
                          <DataTableRow key={row.id}>
                            <DataTableCell className="font-medium">{row.name}</DataTableCell>
                            <DataTableCell className="font-mono text-sm">
                              {row.secret_hint ?? '—'}
                            </DataTableCell>
                            <DataTableCell>
                              <span className="inline-flex items-center gap-1.5">
                                <Badge variant={statusVariant[row.status]}>
                                  {row.status === 'active'
                                    ? t('common.active')
                                    : t('common.disabled')}
                                </Badge>
                                {cooling ? (
                                  <Badge variant="warning">{t('supplySources.cooling')}</Badge>
                                ) : null}
                              </span>
                            </DataTableCell>
                            <DataTableCell className="font-mono text-sm tabular-nums">
                              {quotaText(row.quota)}
                            </DataTableCell>
                            <DataTableCell>
                              <DateTimeText value={row.cooldown_until} className="text-sm" />
                            </DataTableCell>
                            <DataTableCell className="text-right">
                              <div className="inline-flex items-center gap-1">
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={
                                    row.status === 'active'
                                      ? t('common.disable')
                                      : t('common.enable')
                                  }
                                  disabled={toggleCredential.isPending}
                                  onClick={() =>
                                    toggleCredential.mutate({
                                      id: row.id,
                                      status: row.status === 'active' ? 'disabled' : 'active',
                                    })
                                  }
                                >
                                  <Power />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={t('common.delete')}
                                  onClick={() => {
                                    deleteCredential.reset();
                                    setCredDeleting(row);
                                  }}
                                >
                                  <Trash2 />
                                </Button>
                              </div>
                            </DataTableCell>
                          </DataTableRow>
                        );
                      })}
                    </DataTableBody>
                  </DataTable>
                </div>
                <LoadMore
                  count={credentials.rows.length}
                  hasMore={credentials.hasNextPage}
                  loading={credentials.isFetchingNextPage}
                  onLoadMore={() => void credentials.fetchNextPage()}
                />
              </>
            )}
          </Card>
        </>
      ) : null}

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('supplySources.editChannel')}</DialogTitle>
            <DialogDescription>{t('supplySources.providerLockedHint')}</DialogDescription>
          </DialogHeader>
          {editForm ? (
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (editForm.name.trim() === '' || updateChannel.isPending) return;
                updateChannel.mutate({
                  name: editForm.name.trim(),
                  auth_scheme: editForm.authScheme,
                  base_url: editForm.baseUrl.trim() === '' ? null : editForm.baseUrl.trim(),
                  region: editForm.region.trim() === '' ? null : editForm.region.trim(),
                  tags: editForm.tags
                    .split(',')
                    .map((tag) => tag.trim())
                    .filter((tag) => tag !== ''),
                  route_group_id:
                    editForm.routeGroupId.trim() === '' ? null : editForm.routeGroupId.trim(),
                  status: editForm.status,
                });
              }}
            >
              <FormField label={t('common.name')}>
                {(id) => (
                  <Input
                    id={id}
                    value={editForm.name}
                    onChange={(event) =>
                      setEditForm((f) => (f ? { ...f, name: event.target.value } : f))
                    }
                  />
                )}
              </FormField>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label={t('supplySources.fieldAuthScheme')}>
                  {() => (
                    <Select
                      value={editForm.authScheme}
                      onValueChange={(value) =>
                        setEditForm((f) => (f ? { ...f, authScheme: value as AuthScheme } : f))
                      }
                    >
                      <SelectTrigger aria-label={t('supplySources.fieldAuthScheme')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {AUTH_SCHEMES.map((item) => (
                          <SelectItem key={item} value={item}>
                            {item}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </FormField>
                <FormField label={t('common.status')}>
                  {() => (
                    <Select
                      value={editForm.status}
                      onValueChange={(value) =>
                        setEditForm((f) => (f ? { ...f, status: value as ChannelStatus } : f))
                      }
                    >
                      <SelectTrigger aria-label={t('common.status')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="active">{t('common.active')}</SelectItem>
                        <SelectItem value="disabled">{t('common.disabled')}</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </FormField>
              </div>
              <FormField
                label={t('supplySources.fieldBaseUrl')}
                hint={t('supplySources.baseUrlHint')}
              >
                {(id) => (
                  <Input
                    id={id}
                    value={editForm.baseUrl}
                    onChange={(event) =>
                      setEditForm((f) => (f ? { ...f, baseUrl: event.target.value } : f))
                    }
                  />
                )}
              </FormField>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label={t('supplySources.fieldRegion')} hint={t('common.optional')}>
                  {(id) => (
                    <Input
                      id={id}
                      value={editForm.region}
                      onChange={(event) =>
                        setEditForm((f) => (f ? { ...f, region: event.target.value } : f))
                      }
                    />
                  )}
                </FormField>
                <FormField
                  label={t('supplySources.fieldRouteGroup')}
                  hint={t('supplySources.routeGroupHint')}
                >
                  {(id) => (
                    <Input
                      id={id}
                      value={editForm.routeGroupId}
                      onChange={(event) =>
                        setEditForm((f) => (f ? { ...f, routeGroupId: event.target.value } : f))
                      }
                    />
                  )}
                </FormField>
              </div>
              <FormField label={t('supplySources.fieldTags')} hint={t('supplySources.tagsHint')}>
                {(id) => (
                  <Input
                    id={id}
                    value={editForm.tags}
                    onChange={(event) =>
                      setEditForm((f) => (f ? { ...f, tags: event.target.value } : f))
                    }
                  />
                )}
              </FormField>
              {updateChannel.isError ? (
                <p className="text-sm text-danger">
                  {toApiStateError(updateChannel.error).message}
                </p>
              ) : null}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditOpen(false)}
                  disabled={updateChannel.isPending}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  type="submit"
                  disabled={editForm.name.trim() === '' || updateChannel.isPending}
                >
                  {t('common.save')}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={credOpen} onOpenChange={setCredOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('supplySources.newCredential')}</DialogTitle>
            <DialogDescription>{t('supplySources.secretWriteOnlyHint')}</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canCreateCredential || createCredential.isPending) return;
              submitCredential();
            }}
          >
            <FormField label={t('common.name')}>
              {(id) => (
                <Input
                  id={id}
                  value={credForm.name}
                  onChange={(event) => setCredForm((f) => ({ ...f, name: event.target.value }))}
                />
              )}
            </FormField>
            {scheme === 'ak_sk' ? (
              <>
                <FormField label={t('supplySources.fieldAccessKey')}>
                  {(id) => (
                    <Input
                      id={id}
                      value={credForm.accessKey}
                      onChange={(event) =>
                        setCredForm((f) => ({ ...f, accessKey: event.target.value }))
                      }
                    />
                  )}
                </FormField>
                <FormField label={t('supplySources.fieldSecretKey')}>
                  {(id) => (
                    <Input
                      id={id}
                      type="password"
                      autoComplete="off"
                      value={credForm.secretKey}
                      onChange={(event) =>
                        setCredForm((f) => ({ ...f, secretKey: event.target.value }))
                      }
                    />
                  )}
                </FormField>
                <FormField
                  label={t('supplySources.fieldSigningRegion')}
                  hint={t('common.optional')}
                >
                  {(id) => (
                    <Input
                      id={id}
                      value={credForm.signingRegion}
                      onChange={(event) =>
                        setCredForm((f) => ({ ...f, signingRegion: event.target.value }))
                      }
                    />
                  )}
                </FormField>
              </>
            ) : scheme === 'oauth' ? (
              <>
                <p className="text-sm text-muted-foreground">{t('supplySources.oauthHint')}</p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField label={t('supplySources.fieldClientId')}>
                    {(id) => (
                      <Input
                        id={id}
                        value={credForm.clientId}
                        onChange={(event) =>
                          setCredForm((f) => ({ ...f, clientId: event.target.value }))
                        }
                      />
                    )}
                  </FormField>
                  <FormField label={t('supplySources.fieldClientSecret')}>
                    {(id) => (
                      <Input
                        id={id}
                        type="password"
                        autoComplete="off"
                        value={credForm.clientSecret}
                        onChange={(event) =>
                          setCredForm((f) => ({ ...f, clientSecret: event.target.value }))
                        }
                      />
                    )}
                  </FormField>
                </div>
                <FormField label={t('supplySources.fieldRefreshToken')}>
                  {(id) => (
                    <Input
                      id={id}
                      type="password"
                      autoComplete="off"
                      value={credForm.refreshToken}
                      onChange={(event) =>
                        setCredForm((f) => ({ ...f, refreshToken: event.target.value }))
                      }
                    />
                  )}
                </FormField>
                <FormField label={t('supplySources.fieldAccessToken')}>
                  {(id) => (
                    <Input
                      id={id}
                      type="password"
                      autoComplete="off"
                      value={credForm.accessToken}
                      onChange={(event) =>
                        setCredForm((f) => ({ ...f, accessToken: event.target.value }))
                      }
                    />
                  )}
                </FormField>
              </>
            ) : (
              <FormField label={t('supplySources.fieldApiKey')}>
                {(id) => (
                  <Input
                    id={id}
                    type="password"
                    autoComplete="off"
                    value={credForm.apiKey}
                    onChange={(event) => setCredForm((f) => ({ ...f, apiKey: event.target.value }))}
                  />
                )}
              </FormField>
            )}
            <div className="grid gap-4 sm:grid-cols-3">
              <FormField label={t('supplySources.fieldQuotaRpm')}>
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    min={1}
                    value={credForm.rpm}
                    onChange={(event) => setCredForm((f) => ({ ...f, rpm: event.target.value }))}
                  />
                )}
              </FormField>
              <FormField label={t('supplySources.fieldQuotaTpm')}>
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    min={1}
                    value={credForm.tpm}
                    onChange={(event) => setCredForm((f) => ({ ...f, tpm: event.target.value }))}
                  />
                )}
              </FormField>
              <FormField label={t('supplySources.fieldQuotaConcurrency')}>
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    min={1}
                    value={credForm.maxConcurrency}
                    onChange={(event) =>
                      setCredForm((f) => ({ ...f, maxConcurrency: event.target.value }))
                    }
                  />
                )}
              </FormField>
            </div>
            <p className="text-sm text-muted-foreground">{t('supplySources.quotaHint')}</p>
            {createCredential.isError ? (
              <p className="text-sm text-danger">
                {toApiStateError(createCredential.error).message}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCredOpen(false)}
                disabled={createCredential.isPending}
              >
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={!canCreateCredential || createCredential.isPending}>
                {t('common.create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={discoverOpen} onOpenChange={setDiscoverOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {batchResult
                ? t('supplySources.resultTitle')
                : t('supplySources.discoverDialogTitle')}
            </DialogTitle>
            <DialogDescription>
              {batchResult
                ? t('supplySources.needsPricingSummary', {
                    count: batchResult.needs_pricing_count,
                  })
                : t('supplySources.discoverDialogDescription')}
            </DialogDescription>
          </DialogHeader>

          {batchResult === null ? (
            <>
              {discovered === null || discovered.models.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {t('supplySources.discoverEmpty')}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <DataTable className="min-w-full">
                    <DataTableHeader>
                      <DataTableRow>
                        <DataTableHead className="w-10" aria-label={t('common.actions')} />
                        <DataTableHead>{t('supplySources.colUpstreamModel')}</DataTableHead>
                        <DataTableHead>{t('supplySources.colDisplayName')}</DataTableHead>
                        <DataTableHead>{t('supplySources.colSource')}</DataTableHead>
                        <DataTableHead>{t('supplySources.colBinding')}</DataTableHead>
                      </DataTableRow>
                    </DataTableHeader>
                    <DataTableBody>
                      {discovered.models.map((model) => {
                        const selection = selections[model.upstream_model_name];
                        const checked = selection?.checked ?? false;
                        return (
                          <DataTableRow key={model.upstream_model_name}>
                            <DataTableCell>
                              <Input
                                type="checkbox"
                                className="size-4 shrink-0 rounded-sm p-0 accent-primary"
                                aria-label={model.upstream_model_name}
                                checked={checked}
                                disabled={model.exists_as_offering}
                                onChange={(event) =>
                                  updateSelection(model.upstream_model_name, {
                                    checked: event.target.checked,
                                  })
                                }
                              />
                            </DataTableCell>
                            <DataTableCell className="font-mono text-sm">
                              {model.upstream_model_name}
                            </DataTableCell>
                            <DataTableCell>{model.display_name ?? '—'}</DataTableCell>
                            <DataTableCell>
                              <Badge variant="neutral">
                                {model.source === 'dialect_discovery'
                                  ? t('supplySources.sourceDialect')
                                  : t('supplySources.sourceCatalog')}
                              </Badge>
                            </DataTableCell>
                            <DataTableCell>
                              {model.exists_as_offering ? (
                                <Badge variant="success">
                                  {t('supplySources.existsAsOffering')}
                                </Badge>
                              ) : checked ? (
                                <div className="flex flex-col gap-2">
                                  <Select
                                    value={selection?.modelChoice ?? NEW_MODEL}
                                    onValueChange={(value) =>
                                      updateSelection(model.upstream_model_name, {
                                        modelChoice: value,
                                      })
                                    }
                                  >
                                    <SelectTrigger
                                      className="h-8 text-xs"
                                      aria-label={t('supplySources.colBinding')}
                                    >
                                      <SelectValue placeholder={t('supplySources.selectModel')} />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value={NEW_MODEL}>
                                        {t('supplySources.bindNewModel')}
                                      </SelectItem>
                                      {models.rows.map((item) => (
                                        <SelectItem key={item.id} value={item.id}>
                                          {`${item.display_name} (${item.name})`}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                  {(selection?.modelChoice ?? NEW_MODEL) === NEW_MODEL ? (
                                    <Input
                                      className="h-8 text-xs"
                                      placeholder={t('supplySources.newModelNamePlaceholder')}
                                      aria-label={t('supplySources.newModelNamePlaceholder')}
                                      value={selection?.newName ?? ''}
                                      onChange={(event) =>
                                        updateSelection(model.upstream_model_name, {
                                          newName: event.target.value,
                                        })
                                      }
                                    />
                                  ) : null}
                                </div>
                              ) : (
                                '—'
                              )}
                            </DataTableCell>
                          </DataTableRow>
                        );
                      })}
                    </DataTableBody>
                  </DataTable>
                </div>
              )}
              {batchMutation.isError ? (
                <p className="text-sm text-danger">
                  {toApiStateError(batchMutation.error).message}
                </p>
              ) : null}
              <DialogFooter className="sm:items-center">
                <span className="mr-auto text-sm text-muted-foreground">
                  {t('supplySources.selectedCount', { count: pickedModels.length })}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDiscoverOpen(false)}
                  disabled={batchMutation.isPending}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  type="button"
                  onClick={submitBatch}
                  disabled={!canCreateOfferings || batchMutation.isPending}
                >
                  {t('supplySources.createOfferings')}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <div className="overflow-x-auto">
                <DataTable className="min-w-full">
                  <DataTableHeader>
                    <DataTableRow>
                      <DataTableHead>{t('supplySources.colUpstreamModel')}</DataTableHead>
                      <DataTableHead>{t('common.status')}</DataTableHead>
                      <DataTableHead>{t('supplySources.colPricing')}</DataTableHead>
                    </DataTableRow>
                  </DataTableHeader>
                  <DataTableBody>
                    {batchResult.offerings.map((row) => (
                      <DataTableRow key={row.offering.id}>
                        <DataTableCell className="font-mono text-sm">
                          {row.upstream_model_name}
                        </DataTableCell>
                        <DataTableCell>
                          <Badge variant="warning">{row.offering.status}</Badge>
                        </DataTableCell>
                        <DataTableCell>
                          <span className="inline-flex items-center gap-2">
                            <Badge variant={pricingVariant[row.pricing.status]}>
                              {row.pricing.status === 'existing'
                                ? t('supplySources.pricingExisting')
                                : row.pricing.status === 'minted'
                                  ? t('supplySources.pricingMinted')
                                  : t('supplySources.pricingNeedsPricing')}
                            </Badge>
                            {row.pricing.message !== undefined ? (
                              <span className="text-xs text-muted-foreground">
                                {row.pricing.message}
                              </span>
                            ) : null}
                          </span>
                        </DataTableCell>
                      </DataTableRow>
                    ))}
                  </DataTableBody>
                </DataTable>
              </div>
              {probeResult ? <ProbeResults result={probeResult} /> : null}
              {probeMutation.isError ? (
                <p className="text-sm text-danger">
                  {toApiStateError(probeMutation.error).message}
                </p>
              ) : null}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDiscoverOpen(false)}
                  disabled={probeMutation.isPending}
                >
                  {t('common.close')}
                </Button>
                <Button
                  type="button"
                  onClick={() =>
                    probeMutation.mutate(
                      batchResult.offerings.map((row) => row.offering.id),
                      { onSuccess: (response) => setProbeResult(response) },
                    )
                  }
                  disabled={probeMutation.isPending || batchResult.offerings.length === 0}
                >
                  <Play />
                  {probeMutation.isPending
                    ? t('supplySources.probing')
                    : t('supplySources.probeAndEnable')}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={credDeleting !== null}
        onOpenChange={(open) => {
          if (!open) setCredDeleting(null);
        }}
        title={t('supplySources.deleteCredentialTitle')}
        description={t('supplySources.deleteCredentialDescription')}
        confirmLabel={t('common.delete')}
        pending={deleteCredential.isPending}
        onConfirm={() => {
          if (credDeleting) deleteCredential.mutate(credDeleting.id);
        }}
      />
    </PageTransition>
  );
}
