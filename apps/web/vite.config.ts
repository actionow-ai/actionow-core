/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API = 'http://localhost:3000';

/**
 * The admin SPA's own routes live under `/console/*` and `/auth/callback`, which
 * COLLIDE with the proxied backend prefixes. Without this, a full-page load/refresh
 * of e.g. `/console/overview` is proxied to the API and 404s. `bypass` returns
 * `/index.html` for browser navigations (Accept: text/html) so the SPA boots and
 * its router handles the path; real API calls (fetch/XHR, whose Accept is not
 * text/html) fall through to the proxy unchanged.
 */
const spaBypass = (req: { headers: Record<string, string | string[] | undefined> }) => {
  const accept = req.headers.accept;
  if (typeof accept === 'string' && accept.includes('text/html')) return '/index.html';
  return undefined;
};

const proxy = {
  '/admin': API,
  '/console': { target: API, bypass: spaBypass },
  '/auth': { target: API, bypass: spaBypass },
  '/v1': API,
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Pre-bundle the app's common runtime deps at dev-server startup so Vite does
  // NOT discover-then-cold-optimize them on first navigation. That cold pass
  // forces a full reload, which flashes a blank page on a deep `/console/*`
  // first load. Dev-only; no production effect.
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react-router-dom',
      '@tanstack/react-query',
      'react-i18next',
      'i18next',
      '@phosphor-icons/react',
    ],
  },
  server: {
    port: 5173,
    proxy,
  },
  preview: {
    port: 4173,
    proxy,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
