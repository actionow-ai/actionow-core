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
  modalities: string[];
  protocol: 'sync' | 'async-poll';
  authStrategy: string;
  handler: string;
  credentialFields: { key: string; label: string; type: 'text' | 'password'; required: boolean }[];
}

/** OpenAI Images (gpt-image-1 / DALL·E): synchronous generations → MediaResult. */
const OPENAI_IMAGES: BuiltinPlugin = {
  slug: 'openai-images',
  label: 'OpenAI Images',
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
 * Async media relay (the seeded huimengi-style task API: submit→poll). Mirrors the
 * code `async-media` adapter as a PLUGIN — proof that a code adapter reduces to a
 * manifest+handler. `config.submitPath`/`config.pollPath` come from the channel.
 */
const ASYNC_MEDIA_RELAY: BuiltinPlugin = {
  slug: 'async-media-relay',
  label: 'Async Media Relay (task submit/poll)',
  modalities: ['image', 'video', 'audio'],
  protocol: 'async-poll',
  authStrategy: 'bearer',
  credentialFields: [{ key: 'api_key', label: 'API Key', type: 'password', required: true }],
  handler: `
    function mapRequest(ctx){
      var i = ctx.inputs || {}, cfg = ctx.config || {};
      var params = { prompt: i.prompt };
      if (i.size) params.size = i.size;
      if (i.duration) params.duration = i.duration;
      if (i.ratio) params.ratio = i.ratio;
      if (i.voice) params.voice = i.voice;
      if (i.format) params.format = i.format;
      return { method:'POST', pathSuffix: cfg.submitPath || '/submit', body: { model: ctx.model, params: params } };
    }
    function mapSubmit(a){ return { upstreamJobId: a.response && a.response.task_id }; }
    function mapPollRequest(a){
      var cfg = (a.ctx && a.ctx.config) || {};
      var path = (cfg.pollPath || '/tasks/{id}').replace('{id}', a.upstreamJobId);
      return { method:'GET', pathSuffix: path };
    }
    function mapPoll(a){
      var r = a.response || {};
      if (r.status === 'failed') return { state:'failed', error: r.error_message || 'task failed' };
      if (r.status !== 'completed') return { state:'running' };
      var res = r.result || {};
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
  `,
};

export const BUILTIN_PLUGINS: BuiltinPlugin[] = [OPENAI_IMAGES, ASYNC_MEDIA_RELAY];

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
    });
  }
}
