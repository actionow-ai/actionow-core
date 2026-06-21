import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';

import i18n from '../../i18n';
import { BalanceCard } from './BalanceCard';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('BalanceCard', () => {
  it('renders the µ-balance as human credits and a top-up link', () => {
    render(
      <MemoryRouter>
        <BalanceCard micro="5000000" label="Balance" cta="Top up" topupTo="/app/billing" />
      </MemoryRouter>,
    );
    expect(screen.getByText('5')).toBeInTheDocument(); // 5,000,000 µ ÷ 1e6
    const link = screen.getByRole('link', { name: 'Top up' });
    expect(link).toHaveAttribute('href', '/app/billing');
  });
});
