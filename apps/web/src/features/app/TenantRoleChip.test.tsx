import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';

import i18n from '../../i18n';
import { TenantRoleChip } from './TenantRoleChip';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('TenantRoleChip', () => {
  it('shows the Admin seat', () => {
    render(<TenantRoleChip role="admin" />);
    expect(screen.getByText('Admin')).toBeInTheDocument();
  });

  it('shows the Member seat', () => {
    render(<TenantRoleChip role="member" />);
    expect(screen.getByText('Member')).toBeInTheDocument();
  });

  it('renders nothing for a system operator (null) or while loading (undefined)', () => {
    const { container, rerender } = render(<TenantRoleChip role={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<TenantRoleChip role={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});
