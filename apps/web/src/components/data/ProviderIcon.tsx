import type { CSSProperties, ReactElement } from 'react';

import anthropicUrl from '../../assets/providers/anthropic.svg';
import cloudflareUrl from '../../assets/providers/cloudflare.svg';
import deepseekUrl from '../../assets/providers/deepseek.svg';
import difyUrl from '../../assets/providers/dify.svg';
import doubaoUrl from '../../assets/providers/doubao.svg';
import ernieUrl from '../../assets/providers/ernie.svg';
import geminiUrl from '../../assets/providers/gemini.svg';
import hunyuanUrl from '../../assets/providers/hunyuan.svg';
import kimiUrl from '../../assets/providers/kimi.svg';
import klingUrl from '../../assets/providers/kling.svg';
import mimoUrl from '../../assets/providers/mimo.svg';
import minimaxUrl from '../../assets/providers/minimax.svg';
import openaiUrl from '../../assets/providers/openai.svg';
import qwenUrl from '../../assets/providers/qwen.svg';
import sparkUrl from '../../assets/providers/spark.svg';
import stepfunUrl from '../../assets/providers/stepfun.svg';
import viduUrl from '../../assets/providers/vidu.svg';
import volcengineUrl from '../../assets/providers/volcengine.svg';
import xaiUrl from '../../assets/providers/xai.svg';
import zhipuUrl from '../../assets/providers/zhipu.svg';

interface Brand {
  src: string;
  label: string;
  /** Normalized slugs (lowercase, alphanumeric) that resolve to this brand by substring. */
  match: string[];
  /** Marks designed white-on-dark (e.g. Kimi) need a dark plate to stay legible. */
  tone?: 'dark';
}

/**
 * Real vendor brand marks, stored locally as SVGs under assets/providers and
 * inlined as base64 at build time. Brand colours are intentional — a vendor
 * logo recoloured is no longer "the real icon". `match` keys cover the common
 * backend provider_type / model-family aliases (incl. romanized CN names).
 */
const BRANDS: Brand[] = [
  { src: openaiUrl, label: 'OpenAI', match: ['openai', 'gpt', 'oai', 'codex'] },
  { src: anthropicUrl, label: 'Anthropic', match: ['anthropic', 'claude'] },
  { src: geminiUrl, label: 'Gemini', match: ['gemini', 'google', 'vertex', 'palm'] },
  { src: xaiUrl, label: 'xAI', match: ['xai', 'grok'] },
  { src: deepseekUrl, label: 'DeepSeek', match: ['deepseek'] },
  // Chinese vendors
  { src: qwenUrl, label: 'Qwen', match: ['qwen', 'tongyi', 'dashscope', 'qianwen', 'alibaba'] },
  { src: zhipuUrl, label: 'Zhipu', match: ['zhipu', 'glm', 'chatglm', 'bigmodel'] },
  { src: kimiUrl, label: 'Kimi', match: ['kimi', 'moonshot'], tone: 'dark' },
  { src: minimaxUrl, label: 'MiniMax', match: ['minimax', 'abab'] },
  { src: volcengineUrl, label: 'Volcengine', match: ['volcengine', 'volcano', 'huoshan'] },
  { src: doubaoUrl, label: 'Doubao', match: ['doubao', 'bytedance'] },
  { src: ernieUrl, label: 'ERNIE', match: ['ernie', 'wenxin', 'baidu', 'qianfan'] },
  { src: hunyuanUrl, label: 'Hunyuan', match: ['hunyuan', 'tencent'] },
  { src: sparkUrl, label: 'Spark', match: ['sparkdesk', 'spark', 'xunfei', 'iflytek'] },
  { src: stepfunUrl, label: 'Step', match: ['stepfun', 'step'] },
  { src: mimoUrl, label: 'MiMo', match: ['xiaomi', 'mimo'] },
  // Video / media generation
  { src: klingUrl, label: 'Kling', match: ['kling', 'keling', 'kuaishou'] },
  { src: viduUrl, label: 'Vidu', match: ['vidu', 'shengshu'] },
  // Orchestration / infra
  { src: cloudflareUrl, label: 'Cloudflare', match: ['cloudflare', 'workersai'] },
  { src: difyUrl, label: 'Dify', match: ['dify'] },
];

function resolve(provider: string): Brand | null {
  const key = provider.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const b of BRANDS) {
    if (b.match.some((m) => key.includes(m))) return b;
  }
  return null;
}

/**
 * Modality-glyph fallbacks for the seeded `generic-{text,image,video,audio}`
 * catalog icon keys — these have no vendor brand mark, so without this they'd
 * render as a bare "G" monogram. Line-icon glyphs drawn in the accent colour.
 */
const GENERIC_GLYPHS: Record<string, { label: string; paths: string[] }> = {
  'generic-text': { label: '文本', paths: ['M5 6h14M5 12h14M5 18h9'] },
  'generic-image': {
    label: '图像',
    paths: ['M4 5h16v14H4z', 'M8.5 10a1.5 1.5 0 1 0 0-.01', 'M5 18l5-5 3 3 3-3 3 3'],
  },
  'generic-video': { label: '视频', paths: ['M4 6h16v12H4z', 'M10 9l6 3-6 3z'] },
  'generic-audio': { label: '音频', paths: ['M5 10v4M9 7v10M13 9v6M17 8v8'] },
};

function genericGlyph(provider: string, size: number): ReactElement | null {
  const g = GENERIC_GLYPHS[provider.toLowerCase()];
  if (!g) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--accent-2)"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {g.paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

export function ProviderIcon({
  provider,
  size = 22,
  tile = true,
  showLabel = false,
  style,
}: {
  provider: string;
  /** Logo glyph size in px. */
  size?: number;
  /** Render on a soft app-tile (default) for cross-theme legibility. */
  tile?: boolean;
  /** Append the vendor name beside the mark. */
  showLabel?: boolean;
  style?: CSSProperties;
}) {
  const brand = resolve(provider);
  const generic = brand ? null : genericGlyph(provider, size);
  const label = brand?.label ?? GENERIC_GLYPHS[provider.toLowerCase()]?.label ?? provider;

  const mark = brand ? (
    <img src={brand.src} width={size} height={size} alt="" aria-hidden="true" draggable={false} />
  ) : (
    (generic ?? (
      <span
        aria-hidden="true"
        style={{ fontSize: size * 0.52, fontWeight: 'var(--fw-bold)', color: 'var(--accent-2)' }}
      >
        {(provider.charAt(0) || '?').toUpperCase()}
      </span>
    ))
  );

  const glyph = tile ? (
    <span
      className={`provider-tile${brand?.tone === 'dark' ? ' provider-tile--dark' : ''}`}
      style={{ width: size + 16, height: size + 16 }}
      title={label}
    >
      {mark}
    </span>
  ) : (
    mark
  );

  if (!showLabel) return glyph;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, ...style }}>
      {glyph}
      <span style={{ fontSize: 'var(--fs-base)', fontWeight: 500 }}>{label}</span>
    </span>
  );
}
