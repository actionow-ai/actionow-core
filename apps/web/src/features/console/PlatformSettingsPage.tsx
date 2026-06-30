import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { QueryBoundary } from '../../components/data/QueryBoundary';
import { Button } from '../../components/ui/Button';
import { NumberField } from '../../components/ui/NumberField';
import { Pill } from '../../components/ui/Pill';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { Toggle } from '../../components/ui/Toggle';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { PlatformSettingView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_REFERENCE } from '../../lib/query';

/** The value-editor shape parsed from a setting's `type` hint. */
type Editor =
  | { kind: 'boolean' }
  | { kind: 'number' }
  | { kind: 'enum'; options: string[] }
  | { kind: 'string' };

/** Stringify an `unknown` setting value safely (primitives verbatim; objects as JSON). */
function toText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** Parse the backend `type` hint (`number` / `boolean` / `enum: a | b`) into an editor. */
function parseEditor(type: string): Editor {
  if (type === 'boolean') return { kind: 'boolean' };
  if (type === 'number') return { kind: 'number' };
  if (type.startsWith('enum:')) {
    const options = type
      .slice('enum:'.length)
      .split('|')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    return { kind: 'enum', options };
  }
  return { kind: 'string' };
}

/**
 * 系统设置 — operator dynamic platform config (动态配置, #50). Lists the eight
 * runtime-tunable settings (`GET /admin/settings`) with their effective value and
 * `source` (env default vs DB override), edits each per its `type` hint, and
 * resets a DB-overridden one back to the env/code default. Every write is audited
 * (see 审计日志, target `platform_setting`). Bootstrap/secret env stays env-only
 * and is intentionally absent here.
 */
export function PlatformSettingsPage() {
  const api = useAdminApi();

  const settings = useQuery({
    queryKey: qk.platformSettings(),
    queryFn: () => api.listPlatformSettings(),
    staleTime: STALE_REFERENCE,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
      <QueryBoundary query={settings}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
          {(settings.data ?? []).map((s) => (
            <SettingRow key={s.key} setting={s} />
          ))}
        </div>
      </QueryBoundary>
    </div>
  );
}

function SettingRow({ setting }: { setting: PlatformSettingView }) {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  const editor = parseEditor(setting.type);

  // Draft value in the editor's native JS type, seeded from the effective value.
  const [draft, setDraft] = useState<string | number | boolean>(() => {
    if (editor.kind === 'boolean') return setting.value === true;
    if (editor.kind === 'number')
      return typeof setting.value === 'number' ? setting.value : Number(setting.value) || 0;
    return toText(setting.value);
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: qk.platformSettings() });
  const save = useMutation({
    mutationFn: () => api.setPlatformSetting(setting.key, draft),
    onSuccess: async () => {
      await invalidate();
      toast(t('settings.saved'));
    },
    onError: mutationError(t),
  });
  const reset = useMutation({
    mutationFn: () => api.resetPlatformSetting(setting.key),
    onSuccess: async () => {
      await invalidate();
      toast(t('settings.reset'));
    },
    onError: mutationError(t),
  });

  // The effective value as a comparable scalar (so "Save" only enables on change).
  const effective =
    editor.kind === 'boolean'
      ? setting.value === true
      : editor.kind === 'number'
        ? typeof setting.value === 'number'
          ? setting.value
          : Number(setting.value) || 0
        : toText(setting.value);
  const changed = draft !== effective;
  const isOverride = setting.source === 'db';

  return (
    <div
      className="panel"
      style={{
        borderRadius: 'var(--r-md)',
        padding: 'var(--s-4)',
        display: 'flex',
        gap: 'var(--s-4)',
        alignItems: 'flex-start',
        flexWrap: 'wrap',
      }}
    >
      <div
        style={{
          flex: 1,
          minWidth: 220,
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--s-1)',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-2)' }}>
          <code style={{ fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-medium)' }}>
            {setting.key}
          </code>
          <Pill tone={isOverride ? 'run' : 'idle'}>
            {isOverride ? t('settings.source.db') : t('settings.source.env')}
          </Pill>
        </span>
        <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--muted)' }}>
          {setting.description}
        </span>
        {isOverride && setting.updated_at !== null && (
          <span style={{ fontSize: 'var(--fs-nano)', color: 'var(--faint)' }}>
            {t('settings.overriddenAt', {
              time: new Date(setting.updated_at).toLocaleString(),
              by: setting.updated_by ?? '—',
            })}
          </span>
        )}
      </div>

      <div
        style={{ flex: '1 1 260px', display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}
      >
        {editor.kind === 'boolean' ? (
          <Toggle
            label={t('settings.value')}
            checked={draft === true}
            onChange={(c) => setDraft(c)}
          />
        ) : editor.kind === 'number' ? (
          <NumberField
            label={t('settings.value')}
            value={typeof draft === 'number' ? draft : 0}
            onChange={(n) => setDraft(n)}
            min={0}
          />
        ) : editor.kind === 'enum' ? (
          <SelectField
            label={t('settings.value')}
            value={String(draft)}
            onChange={(v) => setDraft(v)}
            options={editor.options.map((o) => ({ value: o, label: o }))}
          />
        ) : (
          <TextField
            label={t('settings.value')}
            value={String(draft)}
            onChange={(v) => setDraft(v)}
          />
        )}
        <div style={{ display: 'flex', gap: 'var(--s-2)' }}>
          <Button
            variant="cta"
            size="sm"
            onClick={() => save.mutate()}
            loading={save.isPending}
            disabled={!changed}
          >
            {t('common.save')}
          </Button>
          {isOverride && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => reset.mutate()}
              loading={reset.isPending}
            >
              <ArrowCounterClockwiseIcon size={14} weight="bold" aria-hidden="true" />
              {t('settings.resetToDefault')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
