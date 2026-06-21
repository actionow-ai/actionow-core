import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

// Mutable mocks so each test can pick the deployment mode + auth state.
const cfg = vi.hoisted(() => ({ deploymentMode: 'marketing' as 'app' | 'marketing' }));
vi.mock('./config', () => ({ config: cfg }));

const auth = vi.hoisted(() => ({ user: null as null | { role: string } }));
vi.mock('./lib/auth/AuthProvider', () => ({ useAuth: () => auth }));

// Stub the heavy marketing page so the test stays light.
vi.mock('./features/landing/LandingPage', () => ({ LandingPage: () => <div>LANDING</div> }));

const { RootRoute, homePath } = await import('./RootRoute');

function renderRoot() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<RootRoute />} />
        <Route path="/login" element={<div>LOGIN</div>} />
        <Route path="/app" element={<div>APP</div>} />
        <Route path="/console/dashboard" element={<div>ADMIN</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('homePath', () => {
  it('routes by auth + role', () => {
    expect(homePath(null)).toBe('/login');
    expect(homePath({ role: 'user' })).toBe('/app');
    expect(homePath({ role: 'admin' })).toBe('/console/dashboard');
  });
});

describe('RootRoute deployment-mode switch', () => {
  it('marketing mode serves the landing page at /', async () => {
    cfg.deploymentMode = 'marketing';
    renderRoot();
    expect(await screen.findByText('LANDING')).toBeInTheDocument();
  });

  it('app mode redirects an anonymous visitor to /login', async () => {
    cfg.deploymentMode = 'app';
    auth.user = null;
    renderRoot();
    expect(await screen.findByText('LOGIN')).toBeInTheDocument();
  });

  it('app mode sends a signed-in tenant user to /app', async () => {
    cfg.deploymentMode = 'app';
    auth.user = { role: 'user' };
    renderRoot();
    expect(await screen.findByText('APP')).toBeInTheDocument();
  });

  it('app mode sends an admin to the console dashboard', async () => {
    cfg.deploymentMode = 'app';
    auth.user = { role: 'admin' };
    renderRoot();
    expect(await screen.findByText('ADMIN')).toBeInTheDocument();
  });
});
