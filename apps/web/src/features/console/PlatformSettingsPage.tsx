import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { QueryBoundary } from '../../components/data/QueryBoundary';
import { Button } from '../../components/ui/Button';
import { NumberField } from '../../components/ui/NumberField';
import { Panel } from '../../components/ui/Panel';
import { Pill } from '../../components/ui/Pill';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { Select } from '../../components/ui/Select';
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

/** Fixed editor width so the value column lines up across rows. */
const EDITOR_W = 240;

/** Ordered presentation groups; a key lands in the first matching one. */
const GROUP_ORDER = ['trace', 'rateLimit', 'other'] as const;
type GroupKey = (typeof GROUP_ORDER)[number];
function groupFor(key: string): GroupKey {
  if (key.startsWith('RELAY_TRACE')) return 'trace';
  if (key.includes('RATE_LIMIT')) return 'rateLimit';
  return 'other';
}

/**
 * 系统设置 — operator dynamic platform config (动态配置, #50). Lists the
 * runtime-tunable settings (`GET /admin/settings`) with their effective value and
 * `source` (env default vs DB override), grouped by concern (追踪 / 限流 / 其他)
 * inside one panel per group — a compact settings sheet, not one card per key.
 * Each row edits per its `type` hint; 保存 appears only when the draft differs
 * from the effective value, and a DB override can be reset back to the env/code
 * default. Every write is audited (see 审计日志, target `platform_setting`).
 * Bootstrap/secret env stays env-only and is intentionally absent here.
 */
export function PlatformSettingsPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();

  const settings = useQuery({
    queryKey: qk.platformSettings(),
    queryFn: () => api.listPlatformSettings(),
    staleTime: STALE_REFERENCE,
  });
  const rows = settings.data ?? [];
  const groups = GROUP_ORDER.map((key) => ({
    key,
    items: rows.filter((s) => groupFor(s.key) === key),
  })).filter((g) => g.items.length > 0);

  return (
    // Reading-form surface: capped like the detail pages, not full-bleed.
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--s-4)',
        maxWidth: 'var(--content-detail)',
      }}
    >
      <QueryBoundary query={settings}>
        {rows.length === 0 ? (
          <div
            style={{
              padding: 'var(--s-6)',
              textAlign: 'center',
              color: 'var(--muted)',
              fontSize: 'var(--fs-sm)',
            }}
          >
            {t('settings.empty')}
          </div>
        ) : (
          groups.map((g) => (
            <section
              key={g.key}
              style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}
            >
              <SectionHeader title={t(`settings.groups.${g.key}`)} />
              <Panel gap="0" padding="0">
                {g.items.map((s, i) => (
                  // Keyed on the effective value AND source: a reset (or another
                  // admin's write) remounts the row so the draft re-seeds — the
                  // editor can never show a stale value beside a fresh source
                  // badge. `source` matters when a reset leaves the value equal
                  // to the env default (only the badge flips).
                  <SettingRow
                    key={`${s.key}:${s.source}:${toText(s.value)}`}
                    setting={s}
                    divider={i > 0}
                  />
                ))}
              </Panel>
            </section>
          ))
        )}
      </QueryBoundary>
    </div>
  );
}

function SettingRow({ setting, divider }: { setting: PlatformSettingView; divider: boolean }) {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  const editor = parseEditor(setting.type);

  // Draft value in the editor's native JS type, seeded from the effective value
  // (the row remounts whenever the effective value changes — see the map key).
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

  // The effective value as a comparable scalar (so 保存 only shows on change).
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
  // Freeze the editor while a write is in flight: the row remounts when the
  // refetch lands, so keystrokes made during the round-trip would be silently
  // dropped by the re-seed.
  const busy = save.isPending || reset.isPending;

  return (
    <div
      style={{
        display: 'flex',
        gap: 'var(--s-4)',
        alignItems: 'center',
        flexWrap: 'wrap',
        padding: 'var(--s-3) var(--s-4)',
        ...(divider ? { borderTop: '1px solid var(--row-bd)' } : null),
      }}
    >
      <div
        style={{
          flex: '1 1 260px',
          minWidth: 220,
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--s-1)',
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--s-2)',
            flexWrap: 'wrap',
          }}
        >
          <span
            className="mono"
            style={{ fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-medium)' }}
          >
            {setting.key}
          </span>
          <Pill tone={isOverride ? 'neutral' : 'idle'}>
            {isOverride ? t('settings.source.db') : t('settings.source.env')}
          </Pill>
        </span>
        <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--muted)' }}>
          {setting.description}
        </span>
        {isOverride && setting.updated_at !== null && (
          <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--faint)' }}>
            {t('settings.overriddenAt', {
              time: new Date(setting.updated_at).toLocaleString(),
              by: setting.updated_by ?? '—',
            })}
          </span>
        )}
      </div>

      {/* Value editor + actions on one line; 保存 only exists once the draft
          differs, so the page never shows a wall of idle CTA buttons. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', flexWrap: 'wrap' }}>
        <div style={{ width: EDITOR_W, display: 'flex', alignItems: 'center' }}>
          {editor.kind === 'boolean' ? (
            <Toggle
              ariaLabel={setting.key}
              checked={draft === true}
              onChange={(c) => setDraft(c)}
              disabled={busy}
            />
          ) : editor.kind === 'number' ? (
            <div style={{ flex: 1 }}>
              <NumberField
                ariaLabel={setting.key}
                value={typeof draft === 'number' ? draft : 0}
                onChange={(n) => setDraft(n)}
                min={0}
                disabled={busy}
              />
            </div>
          ) : editor.kind === 'enum' ? (
            <div style={{ flex: 1 }}>
              <Select
                ariaLabel={setting.key}
                value={String(draft)}
                onChange={(v) => setDraft(v)}
                options={editor.options.map((o) => ({ value: o, label: o }))}
                disabled={busy}
              />
            </div>
          ) : (
            <div style={{ flex: 1 }}>
              <TextField
                ariaLabel={setting.key}
                value={String(draft)}
                onChange={(v) => setDraft(v)}
                disabled={busy}
              />
            </div>
          )}
        </div>
        {changed && (
          <Button variant="cta" size="sm" onClick={() => save.mutate()} loading={save.isPending}>
            {t('common.save')}
          </Button>
        )}
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
  );
}
