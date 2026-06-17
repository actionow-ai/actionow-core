import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { buildSpec, emptySpecForm, type SpecFormState } from '../../components/data/pricebookSpec';
import { PricebookSpecForm } from '../../components/data/PricebookSpecForm';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { NumberField } from '../../components/ui/NumberField';
import { SelectField } from '../../components/ui/SelectField';
import { toast } from '../../components/ui/toast';
import { Toggle } from '../../components/ui/Toggle';
import { PRICEBOOK_METHODS, PRICEBOOK_TIMINGS, toOptions } from '../../lib/api/enums';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { PricebookMethod, PricebookTiming } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

/**
 * Add-price `Modal`. The parent owns the editable `SpecFormState`; the
 * per-method `PricebookSpecForm` edits it and `buildSpec(method, state)`
 * projects out the `spec` at submit — no raw JSON. The human-credit
 * `fixedCredits` (only for `method='fixed'`) is a NumberField here; the backend
 * converts it to µcredits. Open with a fresh `key` so state resets each time.
 */
export function PricingModal({
  resourceId,
  resourceCurrentVersion,
  open,
  onClose,
}: {
  resourceId: string;
  resourceCurrentVersion: number;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();

  const [method, setMethod] = useState<PricebookMethod>('unit');
  const [timing, setTiming] = useState<PricebookTiming>('post');
  const [version, setVersion] = useState(1);
  const [resourceVersion, setResourceVersion] = useState(resourceCurrentVersion);
  const [fixedCredits, setFixedCredits] = useState(0);
  const [active, setActive] = useState(true);
  const [specForm, setSpecForm] = useState<SpecFormState>(emptySpecForm());

  const create = useMutation({
    mutationFn: () =>
      api.createPricebook({
        resourceId,
        resourceVersion,
        version,
        method,
        timing,
        spec: buildSpec(method, specForm),
        fixedCredits: method === 'fixed' ? fixedCredits : undefined,
        active,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.pricebook(resourceId) });
      toast(t('resources.detail.priceAdded'));
      onClose();
    },
    onError: mutationError(t),
  });

  return (
    <Modal
      open={open}
      title={t('resources.detail.addPrice')}
      onClose={onClose}
      footer={
        <Button variant="cta" onClick={() => create.mutate()} loading={create.isPending}>
          {t('resources.detail.addPrice')}
        </Button>
      }
    >
      <SelectField
        label={t('pricebook.form.method')}
        tooltip={t('pricebook.tip.method')}
        value={method}
        onChange={(v) => setMethod(v as PricebookMethod)}
        options={toOptions(PRICEBOOK_METHODS, t)}
      />
      <SelectField
        label={t('pricebook.form.timing')}
        tooltip={t('pricebook.tip.timing')}
        value={timing}
        onChange={(v) => setTiming(v as PricebookTiming)}
        options={toOptions(PRICEBOOK_TIMINGS, t)}
      />
      <NumberField
        label={t('pricebook.form.resourceVersion')}
        tooltip={t('pricebook.tip.resourceVersion')}
        value={resourceVersion}
        onChange={setResourceVersion}
        min={1}
      />
      <NumberField
        label={t('pricebook.form.version')}
        tooltip={t('pricebook.tip.version')}
        value={version}
        onChange={setVersion}
        min={1}
      />
      {method === 'fixed' && (
        <NumberField
          label={t('pricebook.form.fixedCredits')}
          tooltip={t('pricebook.tip.fixedCredits')}
          value={fixedCredits}
          onChange={setFixedCredits}
          min={0}
        />
      )}
      <PricebookSpecForm method={method} value={specForm} onChange={setSpecForm} />
      <Toggle label={t('pricebook.form.active')} checked={active} onChange={setActive} />
    </Modal>
  );
}
