/** Canonical responsive breakpoints as matchMedia query strings. */
export const BP = {
  sm: '(min-width: 640px)',
  md: '(min-width: 768px)',
  wide: '(min-width: 880px)',
  lg: '(min-width: 960px)',
  xl: '(min-width: 1100px)',
} as const;

export type Breakpoint = keyof typeof BP;
