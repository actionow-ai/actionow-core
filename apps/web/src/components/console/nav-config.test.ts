import { CircleIcon, SquareIcon } from '@phosphor-icons/react';
import { describe, expect, it } from 'vitest';

import { activeItem, groupForPath, type NavGroup } from './nav-config';

const GROUPS: NavGroup[] = [
  {
    key: 'a',
    icon: SquareIcon,
    items: [
      { to: '/x/one', labelKey: 'one' },
      { to: '/x/two', labelKey: 'two' },
    ],
  },
  { key: 'b', icon: CircleIcon, items: [{ to: '/y/three', labelKey: 'three' }] },
];

describe('nav-config helpers (parameterized by a groups set)', () => {
  it('groupForPath finds the owning group, else falls back to the first', () => {
    expect(groupForPath('/y/three', GROUPS).key).toBe('b');
    expect(groupForPath('/x/one', GROUPS).key).toBe('a');
    expect(groupForPath('/nowhere', GROUPS).key).toBe('a'); // fallback = first group
  });

  it('activeItem finds the active leaf, else the active group’s first item', () => {
    expect(activeItem('/x/two', GROUPS).labelKey).toBe('two');
    expect(activeItem('/x/missing', GROUPS).labelKey).toBe('one'); // group matched, leaf fallback
  });
});
