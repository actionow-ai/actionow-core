import type { Database } from '@actionow/db';
import { upsertBuiltinPlugin } from '@actionow/db';

/**
 * Built-in provider plugins seeded as DATA (idempotent upsert by slug). These are
 * the OFFICIAL reference plugins the operator clones for the OpenAI-compatible
 * long-tail + third-party relays (spec §3.2 / appendix A). Handlers are pure JS
 * run in the QuickJS sandbox; credentials are applied by the named signer OUTSIDE
 * the sandbox. Adding a new official provider = adding a row here, NOT new code.
 */
interface BuiltinPlugin {
  slug: string;
  label: string;
  /** Seeded icon_asset.key (brand/provider logo); null → derived from slug. */
  icon: string | null;
  modalities: string[];
  protocol: 'sync' | 'async-poll';
  authStrategy: string;
  handler: string;
  credentialFields: { key: string; label: string; type: 'text' | 'password'; required: boolean }[];
}

/** OpenAI Images (gpt-image-1 / DALL·E): synchronous generations → MediaResult. */
const OPENAI_IMAGES: BuiltinPlugin = {
  slug: 'openai-images',
  label: 'OpenAI',
  icon: 'openai',
  modalities: ['image'],
  protocol: 'sync',
  authStrategy: 'bearer',
  credentialFields: [{ key: 'api_key', label: 'API Key', type: 'password', required: true }],
  handler: `
    function mapRequest(ctx){
      var i = ctx.inputs || {};
      var body = { model: ctx.model, prompt: i.prompt, n: i.n || 1, response_format: 'url' };
      if (i.size) body.size = i.size;
      return { method: 'POST', pathSuffix: '/v1/images/generations', body: body };
    }
    function mapResponse(a){
      var data = (a.response && a.response.data) || [];
      var assets = data.map(function(d){
        if (d.b64_json) return { role:'primary', modality:'image', b64:d.b64_json, mime:'image/png' };
        return { role:'primary', modality:'image', url:d.url, mime:'image/png' };
      });
      return { kind:'media', assets: assets, usage: { images: assets.length } };
    }
  `,
};

/**
 * Shared submit→poll handler for the async media families. Vendor specifics are
 * DATA on the channel: `config.submitPath`/`config.pollPath`, the request field
 * shape (this maps the common `prompt`/`size`/`duration`/`ratio`/`voice`/`format`
 * inputs), and the response field names (handles the union of `image_url(s)` /
 * `video_url` / `audio_url`). Auth differs per plugin via the named signer.
 */
const ASYNC_MEDIA_HANDLER = `
    function mapRequest(ctx){
      var i = ctx.inputs || {}, cfg = ctx.config || {};
      var params = { prompt: i.prompt };
      if (i.size) params.size = i.size;
      if (i.duration) params.duration = i.duration;
      if (i.ratio) params.ratio = i.ratio;
      if (i.voice) params.voice = i.voice;
      if (i.format) params.format = i.format;
      if (i.image) params.image = i.image;
      return { method:'POST', pathSuffix: cfg.submitPath || '/submit', body: { model: ctx.model, params: params } };
    }
    function mapSubmit(a){ var r = a.response || {}; return { upstreamJobId: r.task_id || r.id || (r.data && r.data.task_id) }; }
    function mapPollRequest(a){
      var cfg = (a.ctx && a.ctx.config) || {};
      var path = (cfg.pollPath || '/tasks/{id}').replace('{id}', a.upstreamJobId);
      return { method:'GET', pathSuffix: path };
    }
    function mapPoll(a){
      var r = a.response || {};
      var status = r.status || (r.data && r.data.status);
      if (status === 'failed' || status === 'error') return { state:'failed', error: r.error_message || (r.data && r.data.error) || 'task failed' };
      if (status !== 'completed' && status !== 'succeeded' && status !== 'success') return { state:'running' };
      var res = r.result || (r.data && r.data.result) || r.data || {};
      var assets = [];
      if (Array.isArray(res.image_urls)) res.image_urls.forEach(function(u){ assets.push({ role:'primary', modality:'image', url:u, mime:'image/png' }); });
      if (res.image_url) assets.push({ role:'primary', modality:'image', url:res.image_url, mime:'image/png' });
      if (res.video_url) assets.push({ role:'primary', modality:'video', url:res.video_url, mime:'video/mp4', duration: res.duration });
      if (res.audio_url) assets.push({ role:'primary', modality:'audio', url:res.audio_url, mime:'audio/mpeg', duration: res.audio_duration });
      var usage = {};
      if (res.image_count != null) usage.images = res.image_count; else if (assets.length && assets[0].modality === 'image') usage.images = assets.length;
      else if (res.character_count != null) usage.characters = res.character_count;
      else if (res.audio_duration != null) usage.audio_seconds = res.audio_duration;
      else if (res.duration != null) usage.duration_seconds = res.duration;
      else usage.tasks = 1;
      return { state:'succeeded', result: { kind:'media', assets: assets, usage: usage } };
    }
  `;

/** Synchronous single-shot media (the response carries the asset直接返回). */
const SYNC_MEDIA_HANDLER = `
    function mapRequest(ctx){
      var i = ctx.inputs || {}, cfg = ctx.config || {};
      var body = { model: ctx.model, prompt: i.prompt };
      if (i.n) body.n = i.n;
      if (i.size) body.size = i.size;
      if (i.response_format) body.response_format = i.response_format;
      return { method:'POST', pathSuffix: cfg.path || '/v1/images/generations', body: body };
    }
    function mapResponse(a){
      var r = a.response || {};
      var data = r.data || r.images || r.output || [];
      if (!Array.isArray(data)) data = [data];
      var assets = data.map(function(d){
        if (typeof d === 'string') return { role:'primary', modality:'image', url:d, mime:'image/png' };
        if (d && d.b64_json) return { role:'primary', modality:'image', b64:d.b64_json, mime:'image/png' };
        return { role:'primary', modality:'image', url:(d && (d.url || d.image_url)) , mime:'image/png' };
      });
      return { kind:'media', assets: assets, usage: { images: assets.length } };
    }
  `;

/**
 * Chat reverse-proxy passthrough (CLI relays: Codex CLI; claude-code CLI = future).
 * The CLI agent speaks the OpenAI chat protocol; this forwards the body unchanged
 * and tags the upstream response as a `chat` result. Real Codex traffic uses the
 * native OAuth adapter — this plugin row is the 模型接入 grouping + a clonable
 * reference for OpenAI-compatible chat reverse-proxies.
 */
const CHAT_PASSTHROUGH_HANDLER = `
    function mapRequest(ctx){
      var cfg = ctx.config || {};
      return { method:'POST', pathSuffix: cfg.path || '/v1/chat/completions', body: ctx.inputs || {} };
    }
    function mapResponse(a){ return { kind:'chat', response: a.response }; }
  `;

/** Bearer credential (api_key). */
const BEARER_CRED: BuiltinPlugin['credentialFields'] = [
  { key: 'api_key', label: 'API Key', type: 'password', required: true },
];
/** OAuth access-token credential (CLI reverse-proxy). */
const TOKEN_CRED: BuiltinPlugin['credentialFields'] = [
  { key: 'access_token', label: 'Access Token', type: 'password', required: true },
];
/** Access-key/secret-key pair (volcSignV4 / klingJwt). */
const AK_SK_CRED: BuiltinPlugin['credentialFields'] = [
  { key: 'access_key', label: 'Access Key', type: 'text', required: true },
  { key: 'secret_key', label: 'Secret Key', type: 'password', required: true },
];
/** Tencent secret-id/secret-key pair (tencentTC3). */
const TC3_CRED: BuiltinPlugin['credentialFields'] = [
  { key: 'secret_id', label: 'Secret Id', type: 'text', required: true },
  { key: 'secret_key', label: 'Secret Key', type: 'password', required: true },
];

/**
 * Async media relay (generic bearer submit→poll). Covers the long tail of
 * OpenAI-key-style task APIs: seedream / seedance / vidu / runway / minimax 海螺
 * (hailuo) / google veo / 阿里 wan·happyhorse — anything that returns a `task_id`
 * then polls. Vendor paths + field shapes are channel `config` data.
 */
const ASYNC_MEDIA_RELAY: BuiltinPlugin = {
  slug: 'async-media-relay',
  label: '通用异步媒体中转 (seedream · seedance · vidu · runway · 海螺 · veo)',
  icon: 'generic-video',
  modalities: ['image', 'video', 'audio'],
  protocol: 'async-poll',
  authStrategy: 'bearer',
  credentialFields: BEARER_CRED,
  handler: ASYNC_MEDIA_HANDLER,
};

/** Synchronous image (OpenAI-compatible /images/generations). Covers grok image + OpenAI-format relays. */
const SYNC_IMAGE_RELAY: BuiltinPlugin = {
  slug: 'sync-image-relay',
  label: '通用同步图像中转 (OpenAI 兼容 · z-image)',
  icon: 'generic-image',
  modalities: ['image'],
  protocol: 'sync',
  authStrategy: 'bearer',
  credentialFields: BEARER_CRED,
  handler: SYNC_MEDIA_HANDLER,
};

/** 火山引擎 (Volcengine) — body-signed AK/SK native sign-v4 (seedream/seedance/语音复刻). */
const VOLCENGINE_MEDIA: BuiltinPlugin = {
  slug: 'signed-async-media',
  label: '火山引擎 (Volcengine)',
  icon: 'volcengine',
  modalities: ['image', 'video', 'audio'],
  protocol: 'async-poll',
  authStrategy: 'volcSignV4',
  credentialFields: AK_SK_CRED,
  handler: ASYNC_MEDIA_HANDLER,
};

/** 可灵 (Kling) — short-lived JWT from AK/SK (video/image). */
const KLING_MEDIA: BuiltinPlugin = {
  slug: 'jwt-async-media',
  label: '可灵 (Kling)',
  icon: 'kling',
  modalities: ['image', 'video'],
  protocol: 'async-poll',
  authStrategy: 'klingJwt',
  credentialFields: AK_SK_CRED,
  handler: ASYNC_MEDIA_HANDLER,
};

/** 腾讯混元 (Tencent Hunyuan) — TC3-HMAC-SHA256 signed (image/video). */
const TENCENT_MEDIA: BuiltinPlugin = {
  slug: 'tc3-async-media',
  label: '腾讯混元 (Tencent Hunyuan)',
  icon: 'tencent',
  modalities: ['image', 'video'],
  protocol: 'async-poll',
  authStrategy: 'tencentTC3',
  credentialFields: TC3_CRED,
  handler: ASYNC_MEDIA_HANDLER,
};

/** 阿里 (Alibaba) — 通义万相 wan async media over a bearer task API. */
const ALIBABA_MEDIA: BuiltinPlugin = {
  slug: 'alibaba-media',
  label: '阿里 (Alibaba)',
  icon: 'alibaba',
  modalities: ['image', 'video'],
  protocol: 'async-poll',
  authStrategy: 'bearer',
  credentialFields: BEARER_CRED,
  handler: ASYNC_MEDIA_HANDLER,
};

/** MiniMax (海螺 Hailuo) — async video/audio over a bearer task API. */
const MINIMAX_MEDIA: BuiltinPlugin = {
  slug: 'minimax-media',
  label: 'MiniMax (海螺)',
  icon: 'minimax',
  modalities: ['video', 'audio'],
  protocol: 'async-poll',
  authStrategy: 'bearer',
  credentialFields: BEARER_CRED,
  handler: ASYNC_MEDIA_HANDLER,
};

/** xAI (Grok) — synchronous image generation (OpenAI-compatible). */
const XAI_IMAGE: BuiltinPlugin = {
  slug: 'xai-image',
  label: 'xAI (Grok)',
  icon: 'xai',
  modalities: ['image'],
  protocol: 'sync',
  authStrategy: 'bearer',
  credentialFields: BEARER_CRED,
  handler: SYNC_MEDIA_HANDLER,
};

/** Codex CLI — the OpenAI chat CLI reverse-proxy (claude-code CLI = future). */
const CODEX_CLI: BuiltinPlugin = {
  slug: 'codex-cli',
  label: 'Codex CLI',
  icon: 'codex',
  modalities: ['text'],
  protocol: 'sync',
  authStrategy: 'token',
  credentialFields: TOKEN_CRED,
  handler: CHAT_PASSTHROUGH_HANDLER,
};

export const BUILTIN_PLUGINS: BuiltinPlugin[] = [
  OPENAI_IMAGES,
  XAI_IMAGE,
  VOLCENGINE_MEDIA,
  TENCENT_MEDIA,
  KLING_MEDIA,
  ALIBABA_MEDIA,
  MINIMAX_MEDIA,
  CODEX_CLI,
  SYNC_IMAGE_RELAY,
  ASYNC_MEDIA_RELAY,
];

/** Idempotently install/refresh the built-in provider plugins. Network-free. */
export async function seedPlugins(db: Database): Promise<void> {
  for (const p of BUILTIN_PLUGINS) {
    await upsertBuiltinPlugin(db, {
      slug: p.slug,
      label: p.label,
      modalities: p.modalities,
      protocol: p.protocol,
      authStrategy: p.authStrategy,
      manifest: {
        id: p.slug,
        label: p.label,
        modalities: p.modalities,
        protocol: p.protocol,
        authStrategy: p.authStrategy,
        credentialFields: p.credentialFields,
      },
      handler: p.handler,
      icon: p.icon,
    });
  }
}
