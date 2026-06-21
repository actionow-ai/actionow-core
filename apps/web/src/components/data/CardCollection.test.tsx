import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n';
import { CardCollection } from './CardCollection';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('CardCollection error state', () => {
  it('renders an error + retry in place of cards when error is set, and retries on click', async () => {
    const onRetry = vi.fn();
    render(
      <CardCollection
        rows={[] as string[]}
        error
        onRetry={onRetry}
        empty="No cards"
        renderCard={(r) => <span key={r}>{r}</span>}
      />,
    );

    expect(screen.queryByText('No cards')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
