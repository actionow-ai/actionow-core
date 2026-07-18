import '@/index.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ApiError } from '@/api/client';
import { App } from '@/App';
import { initI18n } from '@/lib/i18n';
import { ThemeProvider } from '@/lib/theme';
import { resources } from '@/locales';

initI18n({ resources, storageKey: 'actionow.language' });

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) =>
        failureCount < 2 && error instanceof ApiError && error.retryable && error.status >= 500,
      staleTime: 15_000,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      {/* MotionConfig covers every JS-driven animation; index.css is the CSS backstop. */}
      <MotionConfig reducedMotion="user">
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </MotionConfig>
    </ThemeProvider>
  </StrictMode>,
);
