import { useTranslation } from 'react-i18next';

/** Single geometric brand mark (hexagon) + wordmark. */
export function Logo({ size = 26 }: { size?: number }) {
  const { t } = useTranslation();
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9, fontWeight: 700, fontSize: 16, letterSpacing: '-0.01em' }}>
      <span
        style={{
          width: size,
          height: size,
          borderRadius: 8,
          background: 'linear-gradient(135deg, var(--accent), var(--accent-2))',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--ink)',
          boxShadow: '0 4px 14px rgba(255, 176, 10, 0.4)',
        }}
      >
        <svg width={size * 0.56} height={size * 0.56} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
          <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
        </svg>
      </span>
      {t('brand')}
    </span>
  );
}
