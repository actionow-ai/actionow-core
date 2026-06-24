import { LinkBreakIcon, PencilSimpleIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { Drawer } from '../../components/ui/Drawer';
import { Pill } from '../../components/ui/Pill';
import { enumLabel, MODALITIES } from '../../lib/api/enums';
import type { ModelView } from '../../lib/api/types';

/** µUSD/1M string → `$X.XX` (or `—`). */
function usd(micro: string): string {
  return `$${(Number(micro) / 1_000_000).toFixed(2)}`;
}

/**
 * Read-first detail popup for one model served by a channel (catalog
 * supply-hierarchy). Shows modality, capabilities, price, the channels that
 * serve it (服务通道 — the inverse link), rate limit, fallback chain, visibility.
 * `编辑` opens the ModelEditor; `从通道解绑` removes the link to THIS channel.
 */
export function ModelDetailDrawer({
  model,
  channelLabel,
  servedChannelLabels,
  onEdit,
  onUnlink,
  onClose,
  unlinking,
}: {
  model: ModelView;
  /** The channel this drawer was opened from (for the unbind affordance label). */
  channelLabel: string;
  /** Human labels for `model.served_channel_ids` (resolved by the parent). */
  servedChannelLabels: string[];
  onEdit: () => void;
  onUnlink: () => void;
  onClose: () => void;
  unlinking?: boolean;
}) {
  const { t } = useTranslation('console');
  const caps = Object.entries(model.capabilities)
    .filter(([, on]) => on)
    .map(([k]) => k);

  return (
    <Drawer
      open
      title={model.name}
      onClose={onClose}
      footer={
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-2)', width: '100%' }}>
          <Button variant="ghost" onClick={onEdit}>
            <PencilSimpleIcon size={14} weight="bold" aria-hidden="true" /> {t('common.edit')}
          </Button>
          <Button variant="danger" onClick={onUnlink} loading={unlinking}>
            <LinkBreakIcon size={14} weight="bold" aria-hidden="true" /> {t('models.unlink')}
          </Button>
        </div>
      }
    >
      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 'var(--s-3) var(--s-4)', fontSize: 'var(--fs-sm)' }}>
        <Row label={t('models.cols.modality')}>{enumLabel(t, MODALITIES, model.modality)}</Row>
        {model.maker !== null && <Row label={t('models.form.maker')}>{model.maker}</Row>}
        {model.context_length !== null && (
          <Row label={t('models.form.contextLength')}>
            <span className="tabular">{model.context_length.toLocaleString()}</span>
          </Row>
        )}
        {model.reasoning !== null && (
          <Row label={t('models.form.reasoning')}>{t('models.reasoning.' + model.reasoning, model.reasoning)}</Row>
        )}
        {model.tags.length > 0 && (
          <Row label={t('models.form.tags')}>
            <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-1)' }}>
              {model.tags.map((tg) => (
                <span key={tg} className="chip">
                  {tg}
                </span>
              ))}
            </span>
          </Row>
        )}
        <Row label={t('models.cols.capabilities')}>
          {caps.length === 0 ? (
            '—'
          ) : (
            <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-1)' }}>
              {caps.map((c) => (
                <span key={c} className="chip">
                  {c}
                </span>
              ))}
            </span>
          )}
        </Row>
        <Row label={t('models.detail.price')}>
          <span className="tabular">
            {usd(model.input_price)} / {usd(model.output_price)} /1M
          </span>
        </Row>
        <Row label={t('models.servedChannels')}>
          {servedChannelLabels.length === 0 ? (
            <span style={{ color: 'var(--muted)' }}>{t('models.noServingChannel')}</span>
          ) : (
            <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-1)' }}>
              {servedChannelLabels.map((c) => (
                <span key={c} className="chip">
                  {c}
                </span>
              ))}
            </span>
          )}
        </Row>
        <Row label={t('models.cols.rateLimit', '限流')}>
          {model.rate_limit === null ? '—' : `${String(model.rate_limit)} / min`}
        </Row>
        <Row label={t('models.cols.fallback', '降级链')}>
          {model.fallback_models === null || model.fallback_models.length === 0
            ? '—'
            : model.fallback_models.join(' → ')}
        </Row>
        <Row label={t('models.cols.visibility')}>
          <Pill tone="idle">{model.visibility}</Pill>
        </Row>
        <Row label={t('models.cols.status')}>
          <StatusBadge tone={statusTone(model.status)} label={t('status.' + model.status, model.status)} />
        </Row>
      </dl>
      <p style={{ marginTop: 'var(--s-4)', fontSize: 'var(--fs-caption)', color: 'var(--faint)' }}>
        {t('models.unlinkHint', { channel: channelLabel })}
      </p>
    </Drawer>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{label}</dt>
      <dd style={{ margin: 0, textAlign: 'right', minWidth: 0 }}>{children}</dd>
    </>
  );
}
