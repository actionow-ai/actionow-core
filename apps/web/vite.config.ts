/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API = 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/admin': API,
      '/console': API,
      '/auth': API,
      '/v1': API,
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/admin': API,
      '/console': API,
      '/auth': API,
      '/v1': API,
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
