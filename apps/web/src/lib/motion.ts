// graphite 动效常量。缓动与 spring 参数是体系约定：新代码一律从这里引用，
// 不要在组件里再写字面量。vendored ui/ 层内部的历史字面量以本表为准绳。
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

export const DURATION = {
  fast: 0.16,
  base: 0.28,
  slow: 0.45,
} as const;

export const SPRING = {
  card: { type: 'spring', stiffness: 320, damping: 26 },
  highlight: { type: 'spring', stiffness: 200, damping: 25 },
  panel: { type: 'spring', stiffness: 300, damping: 30 },
  dialog: { type: 'spring', stiffness: 150, damping: 25 },
  sheet: { type: 'spring', stiffness: 150, damping: 22 },
  tooltip: { type: 'spring', stiffness: 300, damping: 35 },
} as const;
