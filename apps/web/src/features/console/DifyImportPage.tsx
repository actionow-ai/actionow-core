import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SecretSelect } from '../../components/data/SecretSelect';
import { Button } from '../../components/ui/Button';
import { JsonField } from '../../components/ui/JsonField';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { Toggle } from '../../components/ui/Toggle';
import { mutationError } from '../../lib/api/mutationError';
import type { DifyImportView, DifyPricingModel } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

export function DifyImportPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const [tenantId, setTenantId] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [yaml, setYaml] = useState('');
  const [pricingModel, setPricingModel] = useState<DifyPricingModel>('fixed');
  const [serviceKeyRef, setServiceKeyRef] = useState('');
  const [allowBlockers, setAllowBlockers] = useState(false);
  const [report, setReport] = useState<DifyImportView | null>(null);

  const submit = useMutation({
    mutationFn: () =>
      api.difyImport({
        tenantId,
        resourceId,
        yaml,
        endpoint,
        pricingModel,
        // Optional service-key binding (a stored secret) + allow blocked
        // workflows (the backend 422s a blocked import otherwise).
        serviceKeyRef: serviceKeyRef === '' ? undefined : serviceKeyRef,
        allowBlockers,
      }),
    onSuccess: (r) => { setReport(r); toast(t('dify.imported')); },
    onError: mutationError(t),
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)', maxWidth: 640 }}>
      <SectionHeader title={t('dify.title')} />
      <TextField label={t('dify.form.tenant')} value={tenantId} onChange={setTenantId} />
      <TextField label={t('dify.form.resourceId')} value={resourceId} onChange={setResourceId} />
      <TextField label={t('dify.form.endpoint')} value={endpoint} onChange={setEndpoint} />
      <JsonField label={t('dify.form.yaml')} value={yaml} onChange={(v) => setYaml(v)} placeholder="app: ..." />
      <SelectField
        label={t('dify.form.pricingModel')}
        value={pricingModel}
        onChange={(v) => setPricingModel(v as DifyPricingModel)}
        options={[
          { value: 'fixed', label: t('dify.pricing.fixed') },
          { value: 'matrix', label: t('dify.pricing.matrix') },
          { value: 'metered', label: t('dify.pricing.metered') },
        ]}
      />
      <SecretSelect
        label={t('dify.form.serviceKeyRef')}
        value={serviceKeyRef}
        onChange={setServiceKeyRef}
        placeholder={t('dify.form.serviceKeyNone')}
      />
      <Toggle
        label={t('dify.form.allowBlockers')}
        checked={allowBlockers}
        onChange={setAllowBlockers}
      />
      <div>
        <Button variant="cta" onClick={() => submit.mutate()} loading={submit.isPending}>
          {t('dify.submit')}
        </Button>
      </div>
      {report && (
        <div className="panel" style={{ borderRadius: 'var(--r-md)', padding: 'var(--s-4)' }}>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 6 }}>{t('dify.report')}</div>
          <pre className="mono" style={{ margin: 0, fontSize: 'var(--fs-sm)', whiteSpace: 'pre-wrap', color: 'var(--text)' }}>
            {JSON.stringify(report.compat_report, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
