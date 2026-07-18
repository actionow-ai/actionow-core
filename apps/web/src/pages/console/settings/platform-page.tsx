import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiFetch, toApiStateError } from '@/api/client';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DateTimeText } from '@/components/common/date-time-text';
import { ApiErrorNotice, ResourceLoading } from '@/components/shell/api-state';
import { EmptyState, PageHeader, PageTransition } from '@/components/shell/page';
import { Button } from '@/components/ui/components/buttons/button';
import { Badge, Card } from '@/components/ui/data-display';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface PlatformSettingView {
  key: string;
  value: unknown;
  source: 'env' | 'db';
  type: string;
  description: string;
  updated_at: string | null;
  updated_by: string | null;
}

const SETTINGS_KEY = ['admin', 'settings'] as const;

/** Serialize the server's `unknown` effective value into an editable draft string. */
function toDraft(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Select options for `boolean` / `enum: a | b` type hints; null → free text/number input. */
function selectOptions(type: string): string[] | null {
  if (type === 'boolean') return ['true', 'false'];
  if (type.startsWith('enum:')) {
    const options = type
      .slice('enum:'.length)
      .split('|')
      .map((option) => option.trim())
      .filter((option) => option !== '');
    return options.length > 0 ? options : null;
  }
  return null;
}

function SettingCard({ setting }: { setting: PlatformSettingView }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => toDraft(setting.value));
  const [resetOpen, setResetOpen] = useState(false);

  const save = useMutation({
    mutationFn: (value: unknown) =>
      apiFetch<PlatformSettingView>(`/admin/settings/${setting.key}`, {
        method: 'PUT',
        body: { value },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
    },
  });
  const reset = useMutation({
    mutationFn: () =>
      apiFetch<PlatformSettingView>(`/admin/settings/${setting.key}`, { method: 'DELETE' }),
    onSuccess: () => {
      setResetOpen(false);
      void queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
    },
  });

  const options = selectOptions(setting.type);
  const isNumber = setting.type === 'number';
  const trimmed = draft.trim();
  const numberValue = Number(trimmed);
  const numberInvalid = isNumber && trimmed !== '' && !Number.isFinite(numberValue);
  const valid = options ? draft !== '' : trimmed !== '' && !numberInvalid;
  const changed = draft !== toDraft(setting.value);
  const parsedValue: unknown =
    setting.type === 'boolean' ? draft === 'true' : isNumber ? numberValue : draft;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-mono text-sm font-semibold">{setting.key}</h2>
        <Badge variant={setting.source === 'db' ? 'primary' : 'neutral'}>
          {setting.source === 'db'
            ? t('platformPages.sourceOverridden')
            : t('platformPages.sourceDefault')}
        </Badge>
        <span className="font-mono text-xs text-muted-foreground">{setting.type}</span>
      </div>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{setting.description}</p>
      {setting.source === 'db' && setting.updated_at ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {t('platformPages.lastUpdated')} <DateTimeText value={setting.updated_at} />
          {setting.updated_by ? (
            <span className="font-mono"> · {setting.updated_by.slice(0, 8)}</span>
          ) : null}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {options ? (
          <Select value={draft} onValueChange={setDraft}>
            <SelectTrigger className="w-full min-w-40 flex-1 sm:max-w-56" aria-label={setting.key}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            inputMode={isNumber ? 'decimal' : undefined}
            aria-label={setting.key}
            className="w-full min-w-40 flex-1 font-mono sm:max-w-56"
          />
        )}
        <Button
          size="sm"
          disabled={!changed || !valid || save.isPending}
          onClick={() => {
            save.mutate(parsedValue);
          }}
        >
          {t('common.save')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={setting.source !== 'db' || reset.isPending}
          onClick={() => {
            setResetOpen(true);
          }}
        >
          {t('platformPages.resetAction')}
        </Button>
      </div>
      {numberInvalid ? (
        <p className="mt-2 text-sm text-danger">{t('platformPages.invalidNumber')}</p>
      ) : null}
      {save.isError ? (
        <p className="mt-2 text-sm text-danger">{toApiStateError(save.error).message}</p>
      ) : null}
      {reset.isError ? (
        <p className="mt-2 text-sm text-danger">{toApiStateError(reset.error).message}</p>
      ) : null}
      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title={t('platformPages.resetTitle')}
        description={t('platformPages.resetDescription', { key: setting.key })}
        confirmLabel={t('platformPages.resetAction')}
        pending={reset.isPending}
        onConfirm={() => {
          reset.mutate();
        }}
      />
    </Card>
  );
}

export function PlatformSettingsPage() {
  const { t } = useTranslation();

  const settings = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => apiFetch<PlatformSettingView[]>('/admin/settings'),
  });

  return (
    <PageTransition>
      <PageHeader
        title={t('platformPages.settingsTitle')}
        description={t('platformPages.settingsDescription')}
      />
      {settings.isLoading ? (
        <ResourceLoading rows={6} className="max-w-2xl" />
      ) : settings.isError ? (
        <ApiErrorNotice
          error={toApiStateError(settings.error)}
          onRetry={() => void settings.refetch()}
          className="max-w-2xl"
        />
      ) : !settings.data || settings.data.length === 0 ? (
        <Card className="max-w-2xl">
          <EmptyState
            icon={SlidersHorizontal}
            title={t('platformPages.settingsEmptyTitle')}
            description={t('platformPages.settingsEmptyDescription')}
          />
        </Card>
      ) : (
        <div className="grid max-w-2xl gap-4">
          {settings.data.map((setting) => (
            <SettingCard
              key={`${setting.key}:${setting.source}:${toDraft(setting.value)}`}
              setting={setting}
            />
          ))}
        </div>
      )}
    </PageTransition>
  );
}
