import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';

import i18n from '../../i18n';
import type { LatestAuditView } from '../../lib/api/types';
import { AuditBadge } from './AuditBadge';

const entry: LatestAuditView = {
  target_id: 'ch1',
  actor_type: 'operator',
  actor_id: 'op-7',
  action: 'channel.disable',
  // Five minutes ago — a stable, recent relative time.
  created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
};

/** Surfaces the current location's pathname + search so a click can be asserted. */
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

function renderBadge(props: { entry?: LatestAuditView; targetType: string; targetId: string }) {
  return render(
    <MemoryRouter initialEntries={['/console/channels']}>
      <Routes>
        <Route
          path="/console/channels"
          element={
            <>
              <AuditBadge {...props} />
              <LocationProbe />
            </>
          }
        />
        <Route path="/console/audit-log" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('AuditBadge', () => {
  it('renders the actor and a relative time from a row', () => {
    renderBadge({ entry, targetType: 'channel', targetId: 'ch1' });
    // The actor surfaces in the badge label.
    expect(screen.getByText(/op-7/)).toBeInTheDocument();
    // A relative-time fragment ("ago") shows alongside it.
    expect(screen.getByText(/ago/)).toBeInTheDocument();
  });

  it('navigates to the audit log filtered to this target on click', async () => {
    const user = userEvent.setup();
    renderBadge({ entry, targetType: 'channel', targetId: 'ch1' });

    await user.click(screen.getByRole('link'));

    const loc = screen.getByTestId('loc').textContent ?? '';
    expect(loc.startsWith('/console/audit-log')).toBe(true);
    expect(loc).toContain('target=channel');
    expect(loc).toContain('target_id=ch1');
  });

  it('renders nothing when there is no audit row', () => {
    const { container } = renderBadge({ entry: undefined, targetType: 'channel', targetId: 'ch1' });
    expect(container.querySelector('a')).toBeNull();
  });
});
