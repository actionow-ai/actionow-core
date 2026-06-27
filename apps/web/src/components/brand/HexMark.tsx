/**
 * The Actionow geometric brand mark: a gold rounded-square holding a hexagon
 * glyph. Decorative (`aria-hidden`) — the accessible name comes from the
 * surrounding wordmark (Logo) or button label (Rail home). Shared so the hexagon
 * path lives in exactly one place.
 */
export function HexMark({
  size = 30,
  shadow = 'var(--glow-accent)',
}: {
  size?: number;
  /** Box-shadow token (Logo uses the stronger --shadow-accent-sm). */
  shadow?: string;
}) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: 8,
        background: 'var(--grad-accent)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--ink)',
        boxShadow: shadow,
      }}
    >
      <svg
        width={size * 0.56}
        height={size * 0.56}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinejoin="round"
      >
        <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      </svg>
    </span>
  );
}
