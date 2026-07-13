import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { IconPicker } from '../../components/data/IconPicker';
import { Button } from '../../components/ui/Button';
import { ChipsField } from '../../components/ui/ChipsField';
import { CodeEditor } from '../../components/ui/CodeEditor';
import { Drawer } from '../../components/ui/Drawer';
import { FormField, useFieldId } from '../../components/ui/FormField';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import type { ProviderPluginView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

const SIGNERS = [
  'bearer',
  'custom-header',
  'query-key',
  'token',
  'volcSignV4',
  'tencentTC3',
  'klingJwt',
  'none',
];
const PROTOCOLS = ['sync', 'async-poll'];

const STARTER_HANDLER = `function mapRequest(ctx){
  return { method: 'POST', pathSuffix: '/v1/images/generations', body: { model: ctx.model, prompt: ctx.inputs.prompt } };
}
function mapResponse(a){
  return { kind: 'media', assets: [{ role: 'primary', modality: 'image', url: a.response.data[0].url, mime: 'image/png' }], usage: { images: 1 } };
}`;

/** Create/edit one plugin (manifest fields + handler code). */
export function PluginEditor({
  plugin,
  onClose,
  onSaved,
}: {
  plugin?: ProviderPluginView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const editing = plugin !== undefined;

  const [slug, setSlug] = useState(plugin?.slug ?? '');
  const [label, setLabel] = useState(plugin?.label ?? '');
  const [modalities, setModalities] = useState<string[]>(plugin?.modalities ?? ['image']);
  const [protocol, setProtocol] = useState<string>(plugin?.protocol ?? 'sync');
  const [authStrategy, setAuthStrategy] = useState<string>(plugin?.auth_strategy ?? 'bearer');
  const [icon, setIcon] = useState<string | null>(plugin?.icon ?? null);
  const [handler, setHandler] = useState(plugin?.handler ?? STARTER_HANDLER);
  const [attempted, setAttempted] = useState(false);
  const handlerId = useFieldId();

  const manifest = () => ({
    id: slug.trim(),
    label: label.trim(),
    modalities,
    protocol: protocol as 'sync' | 'async-poll',
    authStrategy: authStrategy as never,
    credentialFields: plugin?.manifest.credentialFields ?? [
      { key: 'api_key', label: 'API Key', type: 'password' as const, required: true },
    ],
  });

  const save = useMutation({
    mutationFn: async (): Promise<void> => {
      if (editing) {
        await api.updatePlugin(plugin.id, {
          label: label.trim(),
          manifest: manifest(),
          handler,
          icon,
        });
      } else {
        await api.createPlugin({
          slug: slug.trim(),
          label: label.trim(),
          manifest: manifest(),
          handler,
          ...(icon !== null ? { icon } : {}),
        });
      }
    },
    onSuccess: () => {
      toast(t(editing ? 'plugins.updated' : 'plugins.created'));
      onSaved();
    },
    onError: mutationError(t),
  });

  const slugMissing = !editing && slug.trim() === '';
  const labelMissing = label.trim() === '';
  const onSave = () => {
    setAttempted(true);
    if (!slugMissing && !labelMissing) save.mutate();
  };

  return (
    <Drawer
      open
      title={t(editing ? 'plugins.editTitle' : 'plugins.new')}
      onClose={onClose}
      footer={
        <Button variant="cta" onClick={onSave} loading={save.isPending}>
          {t('common.save')}
        </Button>
      }
    >
      <TextField
        label={t('plugins.form.slug')}
        value={slug}
        onChange={setSlug}
        disabled={editing}
        required={!editing}
        error={attempted && slugMissing ? t('plugins.form.slugRequired') : undefined}
      />
      <TextField
        label={t('plugins.form.label')}
        value={label}
        onChange={setLabel}
        required
        error={attempted && labelMissing ? t('plugins.form.labelRequired') : undefined}
      />
      <IconPicker
        label={t('plugins.form.icon')}
        hint={t('plugins.form.iconHint')}
        value={icon}
        onChange={setIcon}
        fallbacks={[slug]}
      />
      <ChipsField
        label={t('plugins.form.modalities')}
        value={modalities}
        onChange={setModalities}
        suggestions={['image', 'video', 'audio', 'chat']}
      />
      <SelectField
        label={t('plugins.form.protocol')}
        value={protocol}
        onChange={setProtocol}
        options={PROTOCOLS.map((p) => ({ value: p, label: p }))}
      />
      <SelectField
        label={t('plugins.form.auth')}
        value={authStrategy}
        onChange={setAuthStrategy}
        options={SIGNERS.map((s) => ({ value: s, label: s }))}
      />

      <FormField
        id={handlerId}
        label={t('plugins.form.handler')}
        hint={t('plugins.form.handlerHint')}
      >
        <CodeEditor value={handler} onChange={setHandler} ariaLabel={t('plugins.form.handler')} />
      </FormField>
    </Drawer>
  );
}
