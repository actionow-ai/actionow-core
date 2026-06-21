import { describe, expect, test } from 'vitest';

import { computeAnchoredPosition } from './floating';

const VIEWPORT = { width: 1000, height: 800 };
// A trigger centered in the viewport (so neither edge nor flip is forced).
const mid = { left: 480, right: 520, top: 400, bottom: 420, width: 40 };

describe('computeAnchoredPosition', () => {
  test('bottom placement sits below the trigger by the gap', () => {
    const r = computeAnchoredPosition({
      trigger: mid,
      content: { width: 200, height: 100 },
      viewport: VIEWPORT,
      placement: 'bottom',
      align: 'start',
      gap: 4,
      margin: 8,
    });
    expect(r.placement).toBe('bottom');
    expect(r.top).toBe(424); // bottom(420) + gap(4)
    expect(r.left).toBe(480); // start-aligned to trigger.left
  });

  test('top placement sits above the trigger by content height + gap', () => {
    const r = computeAnchoredPosition({
      trigger: mid,
      content: { width: 200, height: 100 },
      viewport: VIEWPORT,
      placement: 'top',
      align: 'center',
      gap: 8,
      margin: 8,
    });
    expect(r.placement).toBe('top');
    expect(r.top).toBe(292); // top(400) - height(100) - gap(8)
  });

  test('center align centers the content over the trigger', () => {
    const r = computeAnchoredPosition({
      trigger: mid,
      content: { width: 200, height: 100 },
      viewport: VIEWPORT,
      placement: 'top',
      align: 'center',
      gap: 8,
      margin: 8,
    });
    expect(r.left).toBe(400); // triggerCenter(500) - contentWidth/2(100)
  });

  test('flips top→bottom when there is not enough room above', () => {
    const nearTop = { left: 480, right: 520, top: 40, bottom: 60, width: 40 };
    const r = computeAnchoredPosition({
      trigger: nearTop,
      content: { width: 200, height: 120 },
      viewport: VIEWPORT,
      placement: 'top',
      align: 'center',
      gap: 8,
      margin: 8,
    });
    expect(r.placement).toBe('bottom');
    expect(r.top).toBe(68); // bottom(60) + gap(8)
  });

  test('flips bottom→top when there is not enough room below', () => {
    const nearBottom = { left: 480, right: 520, top: 740, bottom: 760, width: 40 };
    const r = computeAnchoredPosition({
      trigger: nearBottom,
      content: { width: 200, height: 120 },
      viewport: VIEWPORT,
      placement: 'bottom',
      align: 'center',
      gap: 8,
      margin: 8,
    });
    expect(r.placement).toBe('top');
    expect(r.top).toBe(612); // top(740) - height(120) - gap(8)
  });

  test('clamps content within the right viewport margin', () => {
    const nearRight = { left: 940, right: 980, top: 400, bottom: 420, width: 40 };
    const r = computeAnchoredPosition({
      trigger: nearRight,
      content: { width: 200, height: 100 },
      viewport: VIEWPORT,
      placement: 'bottom',
      align: 'center',
      gap: 4,
      margin: 8,
    });
    expect(r.left).toBe(792); // viewport(1000) - margin(8) - width(200)
  });

  test('clamps content within the left viewport margin', () => {
    const nearLeft = { left: 10, right: 50, top: 400, bottom: 420, width: 40 };
    const r = computeAnchoredPosition({
      trigger: nearLeft,
      content: { width: 200, height: 100 },
      viewport: VIEWPORT,
      placement: 'bottom',
      align: 'center',
      gap: 4,
      margin: 8,
    });
    expect(r.left).toBe(8); // clamped up to the left margin
  });
});
