import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n';
import { QueryBoundary } from './QueryBoundary';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

interface Q {
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}
const q = (over: Partial<Q>): Q => ({
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
  ...over,
});

describe('QueryBoundary', () => {
  it('renders children once the query has loaded without error', () => {
    render(
      <QueryBoundary query={q({})}>
        <p>CONTENT</p>
      </QueryBoundary>,
    );
    expect(screen.getByText('CONTENT')).toBeInTheDocument();
  });

  it('shows a loader and hides children while loading', () => {
    render(
      <QueryBoundary query={q({ isLoading: true })}>
        <p>CONTENT</p>
      </QueryBoundary>,
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('CONTENT')).toBeNull();
  });

  it('shows an error state whose retry refetches every query, hiding children', async () => {
    const a = q({ isError: true });
    const b = q({});
    render(
      <QueryBoundary query={[a, b]}>
        <p>CONTENT</p>
      </QueryBoundary>,
    );
    expect(screen.queryByText('CONTENT')).toBeNull();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(a.refetch).toHaveBeenCalledTimes(1);
    expect(b.refetch).toHaveBeenCalledTimes(1);
  });

  it('prioritizes the error state over the loading state', () => {
    render(
      <QueryBoundary query={q({ isLoading: true, isError: true })}>
        <p>CONTENT</p>
      </QueryBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
