import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDebounced } from './useDebounced';

describe('useDebounced', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('commits the local value after the delay, once', () => {
    const commit = vi.fn();
    const { result } = renderHook(() => useDebounced('a', commit, 300));
    act(() => {
      result.current[1]('ab');
    });
    expect(commit).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(commit).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('ab');
  });

  it('resyncs local when the committed value prop changes', () => {
    const commit = vi.fn();
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, commit, 300), {
      initialProps: { v: 'a' },
    });
    rerender({ v: 'z' });
    expect(result.current[0]).toBe('z');
  });
});
