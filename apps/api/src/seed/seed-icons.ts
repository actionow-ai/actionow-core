import type { Database } from '@actionow/db';
import { upsertIconAsset } from '@actionow/db';

/**
 * The seeded icon catalog (catalog icons): the selectable brand/provider icon
 * KEYS an operator attaches to a plugin/channel/model. `svg` is left null —
 * the frontend `BrandIcon` renders these via its built-in provider-image
 * registry (openai/anthropic/google) or a colored monogram; operators may later
 * upload a custom `svg` for a key. Network-free, idempotent.
 */
interface SeedIcon {
  key: string;
  label: string;
  category: string;
}

const ICONS: SeedIcon[] = [
  // Providers / vendors (开发者/厂商).
  { key: 'openai', label: 'OpenAI', category: 'provider' },
  { key: 'anthropic', label: 'Anthropic', category: 'provider' },
  { key: 'google', label: 'Google', category: 'provider' },
  { key: 'volcengine', label: '火山引擎 Volcengine', category: 'provider' },
  { key: 'tencent', label: '腾讯混元 Tencent', category: 'provider' },
  { key: 'alibaba', label: '阿里 Alibaba', category: 'provider' },
  { key: 'kling', label: '可灵 Kling', category: 'provider' },
  { key: 'minimax', label: 'MiniMax', category: 'provider' },
  { key: 'xai', label: 'xAI (Grok)', category: 'provider' },
  { key: 'deepseek', label: 'DeepSeek', category: 'provider' },
  { key: 'moonshot', label: 'Moonshot', category: 'provider' },
  { key: 'baidu', label: 'Baidu', category: 'provider' },
  { key: 'xiaomi', label: 'Xiaomi', category: 'provider' },
  { key: 'codex', label: 'Codex CLI', category: 'provider' },
  // Generic by modality (fallbacks).
  { key: 'generic-text', label: '文本', category: 'generic' },
  { key: 'generic-image', label: '图像', category: 'generic' },
  { key: 'generic-video', label: '视频', category: 'generic' },
  { key: 'generic-audio', label: '音频', category: 'generic' },
];

/** Idempotently install/refresh the seeded icon catalog. */
export async function seedIcons(db: Database): Promise<void> {
  for (const i of ICONS) {
    await upsertIconAsset(db, { key: i.key, label: i.label, category: i.category });
  }
}
