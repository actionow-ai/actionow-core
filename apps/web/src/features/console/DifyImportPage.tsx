import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/ui/Button';
import { JsonField, validateJson } from '../../components/ui/JsonField';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { ApiError } from '../../lib/api/errors';
import type { DifyImportView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

export function DifyImportPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const [tenantId, setTenantId] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [yaml, setYaml] = useState('');
  const [pricing, setPricing] = useState('{\n  "method": "fixed",\n  "timing": "pre"\n}');
  const [pErr, setPErr] = useState<string | undefined>(undefined);
  const [report, setReport] = useState<DifyImportView | null>(null);

  const submit = useMutation({
    mutationFn: () => {
      const parsed = validateJson(pricing);
      if (!parsed.ok) throw new ApiError('invalid_input', parsed.error, 400, false);
      return api.difyImport({ tenantId, resourceId, yaml, endpoint, pricingModel: parsed.value });
    },
    onSuccess: (r) => { setReport(r); toast(t('dify.imported')); },
    onError: (e) => toast(e instanceof ApiError ? t(`errors.${e.code}`, e.message) : t('errors.network'), 'error'),
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)', maxWidth: 640 }}>
      <SectionHeader title={t('dify.title')} />
      <TextField label={t('dify.form.tenant')} value={tenantId} onChange={(e) => setTenantId(e.target.value)} />
      <TextField label={t('dify.form.resourceId')} value={resourceId} onChange={(e) => setResourceId(e.target.value)} />
      <TextField label={t('dify.form.endpoint')} value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
      <JsonField label={t('dify.form.yaml')} value={yaml} onChange={(v) => setYaml(v)} placeholder="app: ..." />
      <JsonField label={t('dify.form.pricingModel')} value={pricing}
        onChange={(v) => { setPricing(v); setPErr(validateJson(v).ok ? undefined : 'invalid JSON'); }} error={pErr} />
      <div><Button variant="cta" onClick={() => submit.mutate()}>{t('dify.submit')}</Button></div>
      {report && (
        <div className="panel" style={{ borderRadius: 'var(--r-md)', padding: 'var(--s-4)' }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>{t('dify.report')}</div>
          <pre className="mono" style={{ margin: 0, fontSize: 11.5, whiteSpace: 'pre-wrap', color: 'var(--text)' }}>
            {JSON.stringify(report.compat_report, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
