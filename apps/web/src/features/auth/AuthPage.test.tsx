import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n';
import { ApiError } from '../../lib/api/errors';
import { ThemeProvider } from '../../lib/theme/ThemeProvider';

const auth = vi.hoisted(() => ({ login: vi.fn(), register: vi.fn() }));
vi.mock('../../lib/auth/AuthProvider', () => ({
  useAuth: () => ({ ...auth, logout: () => undefined, user: null, isAuthed: false, client: {} }),
}));

// Imported after the mock so AuthPage picks up the mocked useAuth.
const { AuthPage } = await import('./AuthPage');

const renderAuth = () =>
  render(
    <ThemeProvider>
      <MemoryRouter>
        <AuthPage />
      </MemoryRouter>
    </ThemeProvider>,
  );

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  auth.login.mockReset();
  auth.register.mockReset();
});

describe('AuthPage hardening adapts', () => {
  it('on a 429 login throttle, disables submit and shows a retry countdown from retryAfterMs', async () => {
    auth.login.mockRejectedValueOnce(new ApiError('rate_limited', 'too many requests', 429, true, 3000));
    const user = userEvent.setup();
    const { container } = renderAuth();

    await user.type(container.querySelector('input[type="email"]')!, 'a@b.com');
    await user.type(container.querySelector('input[type="password"]')!, 'secretpw');
    const submit = container.querySelector('button[type="submit"]')!;
    await user.click(submit);

    expect(submit).toBeDisabled();
    expect(submit.textContent).toMatch(/3/); // "...3s" cooldown from retryAfterMs=3000
  });

  it('sets minLength 8 / maxLength 256 on the register password, but not on the login password', async () => {
    const user = userEvent.setup();
    const { container } = renderAuth();

    const loginPw = container.querySelector('input[type="password"]')!;
    expect(loginPw).not.toHaveAttribute('minLength');

    // Switch the segmented control to register (radios: [0]=login, [1]=register).
    await user.click(screen.getAllByRole('radio')[1]!);

    const regPw = container.querySelector('input[type="password"]')!;
    expect(regPw).toHaveAttribute('minLength', '8');
    expect(regPw).toHaveAttribute('maxLength', '256');
  });
});
