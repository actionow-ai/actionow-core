import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n';
import type { ConsoleFileView } from '../../lib/api/types';

const image: ConsoleFileView = {
  id: 'f1',
  status: 'ready',
  content_type: 'image/png',
  size: 2048,
  url: 'https://asset.example/t1/a.png',
  created_at: '2026-06-01T00:00:00Z',
};

const mockApi = vi.hoisted(() => ({
  listFiles: vi.fn(() => Promise.resolve({ rows: [] as unknown[], nextCursor: null })),
}));
vi.mock('../../lib/api/useConsoleApi', () => ({ useConsoleApi: () => mockApi }));

const { AppMedia } = await import('./AppMedia');

function renderPage(entry = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <AppMedia />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  mockApi.listFiles.mockClear();
  mockApi.listFiles.mockResolvedValue({ rows: [image], nextCursor: null });
});

describe('AppMedia gallery', () => {
  it('renders a viewable preview for each ready file', async () => {
    renderPage();
    const img = await screen.findByRole('img');
    expect(img).toHaveAttribute('src', image.url);
    // No kind in the URL → list every kind.
    expect(mockApi.listFiles).toHaveBeenCalledWith({});
  });

  it('passes the URL kind filter through to the query', async () => {
    renderPage('/?kind=video');
    await screen.findByRole('img');
    expect(mockApi.listFiles).toHaveBeenCalledWith({ kind: 'video' });
  });
});
