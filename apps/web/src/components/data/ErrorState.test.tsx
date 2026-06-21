import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n';
import { ErrorState } from './ErrorState';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('ErrorState', () => {
  it('shows the load-failed message and a retry button that calls onRetry', async () => {
    const onRetry = vi.fn();
    render(<ErrorState onRetry={onRetry} />);

    expect(screen.getByText('Failed to load')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('omits the retry button when no onRetry is provided', () => {
    render(<ErrorState />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders a custom message in place of the default', () => {
    render(<ErrorState message="Boom" />);
    expect(screen.getByText('Boom')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load')).toBeNull();
  });

  it('exposes the failure to assistive tech via role="alert"', () => {
    render(<ErrorState />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
