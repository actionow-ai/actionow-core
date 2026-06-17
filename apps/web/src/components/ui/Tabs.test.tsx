import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Tabs } from './Tabs';

const TABS = [
  { value: 'channels', label: 'Channels' },
  { value: 'pricebook', label: 'Pricebook' },
];

describe('Tabs', () => {
  it('renders a tablist with a tab per entry and a tabpanel', () => {
    render(
      <Tabs value="channels" onChange={() => undefined} tabs={TABS}>
        <p>panel body</p>
      </Tabs>,
    );
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByRole('tabpanel')).toHaveTextContent('panel body');
  });

  it('marks the selected tab with aria-selected', () => {
    render(
      <Tabs value="pricebook" onChange={() => undefined} tabs={TABS}>
        <p>body</p>
      </Tabs>,
    );
    expect(screen.getByRole('tab', { name: 'Channels' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'Pricebook' })).toHaveAttribute('aria-selected', 'true');
  });

  it('fires onChange when a tab is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Tabs value="channels" onChange={onChange} tabs={TABS}>
        <p>body</p>
      </Tabs>,
    );
    await user.click(screen.getByRole('tab', { name: 'Pricebook' }));
    expect(onChange).toHaveBeenCalledWith('pricebook');
  });

  it('moves selection with the right arrow key (roving focus)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Tabs value="channels" onChange={onChange} tabs={TABS}>
        <p>body</p>
      </Tabs>,
    );
    await user.tab();
    expect(screen.getByRole('tab', { name: 'Channels' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('pricebook');
  });

  it('only the selected tab is in the tab order', () => {
    render(
      <Tabs value="channels" onChange={() => undefined} tabs={TABS}>
        <p>body</p>
      </Tabs>,
    );
    expect(screen.getByRole('tab', { name: 'Channels' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Pricebook' })).toHaveAttribute('tabindex', '-1');
  });
});
