import { z } from 'zod';

/**
 * The named platform-side auth/signer strategies (spec D7 / §4.5). Each runs
 * OUTSIDE the handler sandbox, after `mapRequest`, consuming the built request +
 * resolved credentials — so body-dependent signing (Volcengine V4, Tencent TC3,
 * Kling JWT) works while secrets never enter the sandbox.
 */
export const SIGNER_STRATEGIES = [
  'bearer',
  'query-key',
  'custom-header',
  'token',
  'volcSignV4',
  'tencentTC3',
  'klingJwt',
  'none',
] as const;
export const signerStrategySchema = z.enum(SIGNER_STRATEGIES);
export type SignerStrategy = z.infer<typeof signerStrategySchema>;

/** Protocols the plugin engine drives this phase (webhook-only/ws-stream reserved). */
export const PLUGIN_PROTOCOLS = ['sync', 'async-poll'] as const;
export const pluginProtocolSchema = z.enum(PLUGIN_PROTOCOLS);
export type PluginProtocol = z.infer<typeof pluginProtocolSchema>;

/**
 * One declarative form field — drives the operator UI's credential/param form
 * (≈ Dify `credentials_for_provider`). Used for both the auth credential form and
 * the tunable-params form.
 */
export const credentialFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(['text', 'password', 'select']),
  required: z.boolean().default(false),
  options: z.array(z.string()).optional(),
  placeholder: z.string().optional(),
});
export type CredentialField = z.infer<typeof credentialFieldSchema>;

/** The declarative half of a provider plugin (the handler JS is stored separately). */
export const pluginManifestSchema = z.object({
  /** Stable slug identity, e.g. 'openai-chat'. */
  id: z.string().min(1),
  label: z.string().min(1),
  modalities: z.array(z.string()),
  protocol: pluginProtocolSchema,
  authStrategy: signerStrategySchema,
  credentialFields: z.array(credentialFieldSchema).default([]),
  paramFields: z.array(credentialFieldSchema).optional(),
});
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

/** The admin/API view of one `provider_plugin` row. */
export const providerPluginViewSchema = z.object({
  id: z.string(),
  slug: z.string(),
  label: z.string(),
  modalities: z.array(z.string()),
  protocol: pluginProtocolSchema,
  auth_strategy: signerStrategySchema,
  manifest: pluginManifestSchema,
  handler: z.string(),
  version: z.number().int(),
  builtin: z.boolean(),
  /** Selectable icon key (icon_asset.key); null → derived from slug. */
  icon: z.string().nullable(),
  /** Live channels bound to this plugin (模型接入 card stat). */
  channel_count: z.number(),
  /** Distinct live models served across this plugin's channels (card stat + default sort). */
  model_count: z.number(),
  status: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ProviderPluginView = z.infer<typeof providerPluginViewSchema>;

export const createPluginRequestSchema = z.object({
  slug: z.string().min(1),
  label: z.string().min(1),
  manifest: pluginManifestSchema,
  handler: z.string().min(1),
  icon: z.string().optional(),
});
export type CreatePluginRequest = z.infer<typeof createPluginRequestSchema>;

export const updatePluginRequestSchema = z.object({
  label: z.string().min(1).optional(),
  manifest: pluginManifestSchema.optional(),
  handler: z.string().min(1).optional(),
  icon: z.string().nullable().optional(),
  status: z.string().optional(),
});
export type UpdatePluginRequest = z.infer<typeof updatePluginRequestSchema>;
