import type { CreateSupplyModelBody, Model, ModelOperation } from '@actionow/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Boxes, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { apiFetch, toApiStateError } from '@/api/client';
import { useCursorQuery } from '@/api/hooks';
import { DateTimeText } from '@/components/common/date-time-text';
import { FormField } from '@/components/common/form-field';
import { LoadMore } from '@/components/common/load-more';
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

const modelStatusVariant = {
  draft: 'neutral',
  active: 'success',
  deprecated: 'warning',
  disabled: 'danger',
} as const;

/** Minimal-create presets: the required `operations[]` is derived from the modality. */
const MODALITY_PRESETS: readonly { modality: string; operation: ModelOperation }[] = [
  {
    modality: 'text',
    operation: {
      operation: 'chat.completions',
      paradigms: ['sync', 'stream'],
      slow: false,
      params: [],
    },
  },
  {
    modality: 'image',
    operation: { operation: 'images.generation', paradigms: ['sync'], slow: false, params: [] },
  },
  {
    modality: 'video',
    operation: { operation: 'video.generation', paradigms: ['task'], slow: false, params: [] },
  },
  {
    modality: 'audio',
    operation: { operation: 'tts', paradigms: ['sync'], slow: false, params: [] },
  },
  {
    modality: 'music',
    operation: { operation: 'music.generation', paradigms: ['task'], slow: false, params: [] },
  },
];

export function ModelsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const models = useCursorQuery<Model>({
    key: ['admin', 'supply', 'models'],
    path: '/admin/supply/models',
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [modality, setModality] = useState('text');

  const createModel = useMutation({
    mutationFn: (body: CreateSupplyModelBody) =>
      apiFetch<Model>('/admin/supply/models', { method: 'POST', body }),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'supply', 'models'] });
      setCreateOpen(false);
      void navigate(`/console/supply/models/${created.id}`);
    },
  });

  const handleCreateOpenChange = (open: boolean) => {
    setCreateOpen(open);
    if (open) {
      setName('');
      setDisplayName('');
      setModality('text');
      createModel.reset();
    }
  };

  const submitCreate = () => {
    const preset = MODALITY_PRESETS.find((entry) => entry.modality === modality);
    if (!preset || name.trim() === '' || displayName.trim() === '') return;
    createModel.mutate({
      name: name.trim(),
      display_name: displayName.trim(),
      modality: preset.modality,
      operations: [preset.operation],
    });
  };

  const createButton = (
    <Button onClick={() => handleCreateOpenChange(true)}>
      <Plus />
      {t('supplyModels.createModel')}
    </Button>
  );

  return (
    <PageTransition>
      <PageHeader
        title={t('supplyModels.modelsTitle')}
        description={t('supplyModels.modelsDescription')}
        actions={createButton}
      />

      {models.isLoading ? (
        <ResourceLoading rows={5} />
      ) : models.isError ? (
        <ApiErrorNotice
          error={toApiStateError(models.error)}
          onRetry={() => void models.refetch()}
        />
      ) : (
        <Card>
          <DataTableToolbar
            onRefresh={() => void models.refetch()}
            refreshing={models.isRefetching}
          />
          {models.rows.length === 0 ? (
            <EmptyState
              icon={Boxes}
              title={t('supplyModels.emptyModelsTitle')}
              description={t('supplyModels.emptyModelsDescription')}
              action={createButton}
            />
          ) : (
            <>
              <div className="overflow-x-auto">
                <DataTable>
                  <DataTableHeader>
                    <DataTableRow>
                      <DataTableHead>{t('supplyModels.colName')}</DataTableHead>
                      <DataTableHead>{t('supplyModels.colDisplayName')}</DataTableHead>
                      <DataTableHead>{t('supplyModels.colModality')}</DataTableHead>
                      <DataTableHead>{t('common.status')}</DataTableHead>
                      <DataTableHead>{t('supplyModels.colVisibility')}</DataTableHead>
                      <DataTableHead>{t('supplyModels.colPricing')}</DataTableHead>
                      <DataTableHead>{t('common.createdAt')}</DataTableHead>
                    </DataTableRow>
                  </DataTableHeader>
                  <DataTableBody>
                    {models.rows.map((row) => (
                      <DataTableRow
                        key={row.id}
                        className="cursor-pointer"
                        onClick={() => void navigate(`/console/supply/models/${row.id}`)}
                      >
                        <DataTableCell className="font-mono text-sm">{row.name}</DataTableCell>
                        <DataTableCell>{row.display_name}</DataTableCell>
                        <DataTableCell>
                          <Badge variant="neutral">{row.modality}</Badge>
                        </DataTableCell>
                        <DataTableCell>
                          <Badge variant={modelStatusVariant[row.status]}>
                            {t(`supplyModels.modelStatus.${row.status}`)}
                          </Badge>
                        </DataTableCell>
                        <DataTableCell>
                          {t(`supplyModels.visibility.${row.visibility}`)}
                        </DataTableCell>
                        <DataTableCell>
                          {row.price_card_id === null ? (
                            <Badge variant="warning">{t('supplyModels.needsPricing')}</Badge>
                          ) : (
                            <Badge variant="neutral">{t('supplyModels.priced')}</Badge>
                          )}
                        </DataTableCell>
                        <DataTableCell>
                          <DateTimeText value={row.created_at} className="text-xs" />
                        </DataTableCell>
                      </DataTableRow>
                    ))}
                  </DataTableBody>
                </DataTable>
              </div>
              <div className="px-4 pb-3">
                <LoadMore
                  count={models.rows.length}
                  hasMore={models.hasNextPage}
                  loading={models.isFetchingNextPage}
                  onLoadMore={() => void models.fetchNextPage()}
                />
              </div>
            </>
          )}
        </Card>
      )}

      <Dialog open={createOpen} onOpenChange={handleCreateOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('supplyModels.createModelTitle')}</DialogTitle>
            <DialogDescription>{t('supplyModels.createModelDescription')}</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              submitCreate();
            }}
          >
            <FormField label={t('supplyModels.fieldName')} hint={t('supplyModels.fieldNameHint')}>
              {(id) => (
                <Input
                  id={id}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="font-mono"
                  autoComplete="off"
                  required
                />
              )}
            </FormField>
            <FormField label={t('supplyModels.fieldDisplayName')}>
              {(id) => (
                <Input
                  id={id}
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  autoComplete="off"
                  required
                />
              )}
            </FormField>
            <FormField
              label={t('supplyModels.fieldModality')}
              hint={t('supplyModels.fieldModalityHint')}
            >
              {(id) => (
                <Select value={modality} onValueChange={setModality}>
                  <SelectTrigger id={id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MODALITY_PRESETS.map((entry) => (
                      <SelectItem key={entry.modality} value={entry.modality}>
                        {t(`supplyModels.modality.${entry.modality}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
            {createModel.isError ? (
              <p className="text-sm text-danger">{toApiStateError(createModel.error).message}</p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleCreateOpenChange(false)}
                disabled={createModel.isPending}
              >
                {t('common.cancel')}
              </Button>
              <Button
                type="submit"
                disabled={createModel.isPending || name.trim() === '' || displayName.trim() === ''}
              >
                {t('common.create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}
