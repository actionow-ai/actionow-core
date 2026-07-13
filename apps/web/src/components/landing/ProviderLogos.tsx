import { ProviderIcon } from '../data/ProviderIcon';

/** Vendors Actionow relays / brokers — real brand marks on soft app-tiles. */
const PROVIDERS = [
  'openai',
  'anthropic',
  'gemini',
  'xai',
  'deepseek',
  'qwen',
  'zhipu',
  'kimi',
  'minimax',
  'volcengine',
  'doubao',
  'ernie',
  'hunyuan',
  'spark',
  'stepfun',
  'mimo',
  'kling',
  'vidu',
  'cloudflare',
];

function Group({ dup }: { dup?: boolean }) {
  return (
    <div
      className={`logo-marquee-group${dup === true ? ' logo-marquee-dup' : ''}`}
      aria-hidden={dup === true}
    >
      {PROVIDERS.map((p) => (
        <ProviderIcon key={p} provider={p} size={22} showLabel />
      ))}
    </div>
  );
}

/** An auto-scrolling, hover-pausing strip; falls back to a scrollable row when motion is reduced. */
export function ProviderLogos() {
  return (
    <div className="logo-marquee" style={{ color: 'var(--muted)' }}>
      <div className="logo-marquee-track">
        <Group />
        <Group dup />
      </div>
    </div>
  );
}
