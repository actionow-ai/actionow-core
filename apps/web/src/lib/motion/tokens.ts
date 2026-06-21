/** Motion durations in seconds — mirror of the `--dur-*` CSS tokens (for GSAP). */
export const DUR = {
  instant: 0.12,
  fast: 0.18,
  base: 0.26,
  slow: 0.42,
  slower: 0.7,
} as const;

/** GSAP easing names paired with the CSS `--ease-*` cubic-beziers. */
export const EASE = {
  out: 'power3.out',
  in: 'power2.in',
  inOut: 'power2.inOut',
  spring: 'elastic.out(1, 0.45)',
} as const;
