import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { useUrlState } from './useUrlState';

function wrapper(initialEntries: string[]) {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
  );
}

describe('useUrlState', () => {
  it('falls back to the default when the param is absent', () => {
    const { result } = renderHook(() => useUrlState('tenant', 't0'), {
      wrapper: wrapper(['/console']),
    });
    expect(result.current[0]).toBe('t0');
  });

  it('reflects the value already present in the URL', () => {
    const { result } = renderHook(() => useUrlState('tenant'), {
      wrapper: wrapper(['/console?tenant=t9']),
    });
    expect(result.current[0]).toBe('t9');
  });

  it('setting the value updates the URL search param', () => {
    const { result } = renderHook(() => useUrlState('tenant'), {
      wrapper: wrapper(['/console']),
    });
    act(() => {
      result.current[1]('t5');
    });
    expect(result.current[0]).toBe('t5');
  });

  it('clearing to the empty string drops the param (back to fallback)', () => {
    const { result } = renderHook(() => useUrlState('tenant', ''), {
      wrapper: wrapper(['/console?tenant=t5']),
    });
    act(() => {
      result.current[1]('');
    });
    expect(result.current[0]).toBe('');
  });
});
