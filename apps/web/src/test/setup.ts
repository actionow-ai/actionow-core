import '@testing-library/jest-dom/vitest';

import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { afterEach } from 'vitest';

// jsdom has no ResizeObserver; components (e.g. DataTable's pinned-column scroll
// tracking) construct one. A no-op stub keeps those effects from throwing under
// test — browsers ship the real thing.
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

// GSAP's ticker drives a `requestAnimationFrame` loop. A frame callback that
// fires AFTER jsdom tears down (between test files) hits a now-missing
// `requestAnimationFrame` and crashes the whole run as an unhandled error — a
// flaky, timing-dependent failure. Two guards:
//   (1) a persistent setTimeout-based rAF/cAF polyfill so a stray frame call
//       never throws even once jsdom is gone, and
//   (2) stop GSAP after every test so no frame/ScrollTrigger is left scheduled.
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number =>
    setTimeout(() => cb(Date.now()), 16) as unknown as number) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number): void => {
    clearTimeout(id);
  }) as typeof cancelAnimationFrame;
}

afterEach(() => {
  // Kill any live ScrollTriggers, then put the ticker to sleep — `sleep()`
  // cancels the pending requestAnimationFrame, so nothing leaks into teardown.
  ScrollTrigger.getAll().forEach((t) => {
    t.kill();
  });
  gsap.ticker.sleep();
});
