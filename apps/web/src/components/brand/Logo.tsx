import { config } from '../../config';
import { HexMark } from './HexMark';

/** Single geometric brand mark (hexagon) + wordmark (the white-label brand name). */
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 9,
        fontWeight: 700,
        fontSize: 'var(--fs-md)',
        letterSpacing: '-0.01em',
      }}
    >
      <HexMark size={size} shadow="var(--shadow-accent-sm)" />
      {config.brandName}
    </span>
  );
}
