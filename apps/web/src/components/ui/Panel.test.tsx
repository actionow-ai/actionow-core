import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Panel } from './Panel';

describe('Panel', () => {
  it('applies the panel class and override props', () => {
    const { container } = render(
      <Panel gap="var(--s-2)" padding="var(--s-3)" maxWidth={360} className="x">
        hi
      </Panel>,
    );
    const el = container.firstChild as HTMLElement;
    expect(el.className).toBe('panel x');
    expect(el).toHaveStyle({ gap: 'var(--s-2)', padding: 'var(--s-3)', maxWidth: '360px' });
  });
});
