import type {
  CreateTenantBody,
  ProvisionBody,
  ProvisionView,
  TenantView,
} from '@actionow/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, Rocket } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { apiFetch, toApiStateError } from '@/api/client';
import { useCursorQuery } from '@/api/hooks';
import { CopyButton } from '@/components/common/copy-button';
import { DateTimeText } from '@/components/common/date-time-text';
import { DetailList } from '@/components/common/detail-list';
import { FormField } from '@/components/common/form-field';
import { LoadMore } from '@/components/common/load-more';
import { MoneyText } from '@/components/common/money-text';
import { ApiErrorNotice, ResourceLoading } from '@/components/shell/api-state';
import { EmptyState, PageHeader, PageTransition } from '@/components/shell/page';
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
  DataTableToolbar,
} from '@/components/ui/data-display';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const TENANTS_KEY = ['admin', 'tenants'] as const;

const ISOLATION_KEYS: Record<string, string> = {
  field: 'tenantsAdmin.isolationField',
  schema: 'tenantsAdmin.isolationSchema',
  db: 'tenantsAdmin.isolationDb',
};

type IsolationMode = 'field' | 'schema' | 'db';

function MutationErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="text-sm text-danger">{toApiStateError(error).message}</p>;
}

function IsolationSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: IsolationMode;
  onChange: (value: IsolationMode) => void;
}) {
  const { t } = useTranslation();
  return (
    <Select value={value} onValueChange={(next) => onChange(next as IsolationMode)}>
      <SelectTrigger id={id} aria-label={t('tenantsAdmin.colIsolation')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(['field', 'schema', 'db'] as const).map((mode) => (
          <SelectItem key={mode} value={mode}>
            {t(ISOLATION_KEYS[mode] ?? 'common.none')}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CreateTenantDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [isolation, setIsolation] = useState<IsolationMode>('field');
  const [nameError, setNameError] = useState<string | undefined>(undefined);

  const create = useMutation({
    mutationFn: (body: CreateTenantBody) =>
      apiFetch<TenantView>('/admin/tenants', { method: 'POST', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TENANTS_KEY });
      onOpenChange(false);
      setName('');
      setIsolation('field');
    },
  });

  const submit = () => {
    if (name.trim() === '') {
      setNameError(t('tenantsAdmin.nameRequired'));
      return;
    }
    setNameError(undefined);
    create.mutate({ name: name.trim(), isolationMode: isolation });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('tenantsAdmin.createTenantTitle')}</DialogTitle>
          <DialogDescription>{t('tenantsAdmin.createTenantDescription')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <FormField label={t('common.name')} error={nameError}>
            {(id) => (
              <Input
                id={id}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('tenantsAdmin.namePlaceholder')}
              />
            )}
          </FormField>
          <FormField label={t('tenantsAdmin.colIsolation')} hint={t('tenantsAdmin.isolationHint')}>
            {(id) => <IsolationSelect id={id} value={isolation} onChange={setIsolation} />}
          </FormField>
          <MutationErrorText error={create.error} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending ? t('common.loading') : t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProvisionDialog({
  open,
  onOpenChange,
  onProvisioned,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProvisioned: (result: ProvisionView) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [isolation, setIsolation] = useState<IsolationMode>('field');
  const [credits, setCredits] = useState('');
  const [rateLimit, setRateLimit] = useState('');
  const [formError, setFormError] = useState<{ name?: string; credits?: string; rate?: string }>(
    {},
  );

  const provision = useMutation({
    mutationFn: (body: ProvisionBody) =>
      apiFetch<ProvisionView>('/admin/provision', { method: 'POST', body }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: TENANTS_KEY });
      onOpenChange(false);
      setName('');
      setIsolation('field');
      setCredits('');
      setRateLimit('');
      onProvisioned(result);
    },
  });

  const submit = () => {
    const errors: { name?: string; credits?: string; rate?: string } = {};
    if (name.trim() === '') errors.name = t('tenantsAdmin.nameRequired');
    const creditsValue = credits.trim() === '' ? undefined : Number(credits);
    if (creditsValue !== undefined && (!Number.isFinite(creditsValue) || creditsValue < 0)) {
      errors.credits = t('tenantsAdmin.numberInvalid');
    }
    const rateValue = rateLimit.trim() === '' ? undefined : Number(rateLimit);
    if (rateValue !== undefined && (!Number.isInteger(rateValue) || rateValue <= 0)) {
      errors.rate = t('tenantsAdmin.numberInvalid');
    }
    setFormError(errors);
    if (errors.name || errors.credits || errors.rate) return;
    provision.mutate({
      name: name.trim(),
      isolationMode: isolation,
      ...(creditsValue !== undefined ? { credits: creditsValue } : {}),
      ...(rateValue !== undefined ? { rateLimit: rateValue } : {}),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('tenantsAdmin.provisionTitle')}</DialogTitle>
          <DialogDescription>{t('tenantsAdmin.provisionDescription')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <FormField label={t('common.name')} error={formError.name}>
            {(id) => (
              <Input
                id={id}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('tenantsAdmin.namePlaceholder')}
              />
            )}
          </FormField>
          <FormField label={t('tenantsAdmin.colIsolation')} hint={t('tenantsAdmin.isolationHint')}>
            {(id) => <IsolationSelect id={id} value={isolation} onChange={setIsolation} />}
          </FormField>
          <FormField
            label={t('tenantsAdmin.provisionCredits')}
            hint={t('tenantsAdmin.provisionCreditsHint')}
            error={formError.credits}
          >
            {(id) => (
              <Input
                id={id}
                type="number"
                min={0}
                value={credits}
                onChange={(event) => setCredits(event.target.value)}
              />
            )}
          </FormField>
          <FormField
            label={t('tenantsAdmin.provisionRateLimit')}
            hint={t('tenantsAdmin.provisionRateLimitHint')}
            error={formError.rate}
          >
            {(id) => (
              <Input
                id={id}
                type="number"
                min={1}
                value={rateLimit}
                onChange={(event) => setRateLimit(event.target.value)}
              />
            )}
          </FormField>
          <MutationErrorText error={provision.error} />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={provision.isPending}
          >
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={provision.isPending}>
            {provision.isPending ? t('common.loading') : t('tenantsAdmin.provisionSubmit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProvisionResultDialog({
  result,
  onClose,
}: {
  result: ProvisionView | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={result !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('tenantsAdmin.provisionDoneTitle')}</DialogTitle>
          <DialogDescription>{t('tenantsAdmin.provisionDoneDescription')}</DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="grid gap-4">
            <DetailList
              items={[
                { label: t('tenantsAdmin.resultTenant'), value: result.tenant.name },
                {
                  label: t('tenantsAdmin.resultTenantId'),
                  value: (
                    <span className="inline-flex items-center gap-1">
                      <span className="font-mono text-sm">{result.tenant.id}</span>
                      <CopyButton value={result.tenant.id} />
                    </span>
                  ),
                },
                {
                  label: t('tenantsAdmin.resultAccount'),
                  value: <span className="font-mono text-sm">{result.account.id}</span>,
                },
                {
                  label: t('tenantsAdmin.resultBalance'),
                  value: <MoneyText value={result.account.credit_balance} />,
                },
              ]}
            />
            <div className="rounded-xl bg-surface-subtle p-4">
              <p className="text-sm font-medium">{t('tenantsAdmin.provisionKeyLabel')}</p>
              <div className="mt-2 flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all font-mono text-sm">
                  {result.api_key.plaintext}
                </code>
                <CopyButton
                  value={result.api_key.plaintext}
                  label={t('tenantsAdmin.provisionKeyLabel')}
                />
              </div>
              <p className="mt-3 text-sm text-warning">{t('tenantsAdmin.provisionKeyWarning')}</p>
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button onClick={onClose}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TenantsPage() {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [provisionOpen, setProvisionOpen] = useState(false);
  const [provisionResult, setProvisionResult] = useState<ProvisionView | null>(null);

  const tenants = useCursorQuery<TenantView>({
    key: TENANTS_KEY,
    path: '/admin/tenants',
    limit: 50,
  });

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (query === '') return tenants.rows;
    return tenants.rows.filter(
      (row) => row.name.toLowerCase().includes(query) || row.id.toLowerCase().includes(query),
    );
  }, [tenants.rows, search]);

  return (
    <PageTransition>
      <PageHeader
        title={t('tenantsAdmin.title')}
        description={t('tenantsAdmin.description')}
        actions={
          <>
            <Button variant="outline" onClick={() => setCreateOpen(true)}>
              {t('tenantsAdmin.createTenant')}
            </Button>
            <Button onClick={() => setProvisionOpen(true)}>
              <Rocket />
              {t('tenantsAdmin.provision')}
            </Button>
          </>
        }
      />

      <Card>
        <DataTableToolbar
          search={{
            value: search,
            onChange: setSearch,
            placeholder: t('tenantsAdmin.searchPlaceholder'),
          }}
          onRefresh={() => void tenants.refetch()}
          refreshing={tenants.isRefetching}
        />
        {tenants.isLoading ? (
          <div className="p-4">
            <ResourceLoading rows={5} />
          </div>
        ) : tenants.isError ? (
          <ApiErrorNotice
            className="m-4"
            error={toApiStateError(tenants.error)}
            onRetry={() => void tenants.refetch()}
          />
        ) : tenants.rows.length === 0 ? (
          <EmptyState
            icon={Building2}
            title={t('tenantsAdmin.emptyTitle')}
            description={t('tenantsAdmin.emptyDescription')}
            action={
              <Button onClick={() => setProvisionOpen(true)}>
                <Rocket />
                {t('tenantsAdmin.provision')}
              </Button>
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <DataTable>
                <DataTableHeader>
                  <DataTableRow>
                    <DataTableHead>{t('common.name')}</DataTableHead>
                    <DataTableHead>{t('common.id')}</DataTableHead>
                    <DataTableHead>{t('tenantsAdmin.colIsolation')}</DataTableHead>
                    <DataTableHead>{t('common.createdAt')}</DataTableHead>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {filtered.map((row) => (
                    <DataTableRow key={row.id}>
                      <DataTableCell>
                        <Link
                          to={`/console/tenants/${row.id}`}
                          className="font-medium text-foreground hover:underline"
                        >
                          {row.name}
                        </Link>
                      </DataTableCell>
                      <DataTableCell>
                        <span className="inline-flex items-center gap-1">
                          <span className="font-mono text-sm">{row.id.slice(0, 8)}</span>
                          <CopyButton value={row.id} />
                        </span>
                      </DataTableCell>
                      <DataTableCell>
                        <Badge variant="neutral">
                          {t(ISOLATION_KEYS[row.isolation_mode] ?? 'common.none')}
                        </Badge>
                      </DataTableCell>
                      <DataTableCell>
                        <DateTimeText value={row.created_at} />
                      </DataTableCell>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
            </div>
            <div className="px-4 pb-4">
              <LoadMore
                count={filtered.length}
                hasMore={tenants.hasNextPage}
                loading={tenants.isFetchingNextPage}
                onLoadMore={() => void tenants.fetchNextPage()}
              />
            </div>
          </>
        )}
      </Card>

      <CreateTenantDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ProvisionDialog
        open={provisionOpen}
        onOpenChange={setProvisionOpen}
        onProvisioned={setProvisionResult}
      />
      <ProvisionResultDialog result={provisionResult} onClose={() => setProvisionResult(null)} />
    </PageTransition>
  );
}
