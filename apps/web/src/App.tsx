import { QueryClientProvider } from '@tanstack/react-query';
import { Suspense } from 'react';
import { BrowserRouter } from 'react-router-dom';

import { LoadingScreen } from './components/ui/LoadingScreen';
import { Toaster } from './components/ui/Toaster';
import { AuthProvider } from './lib/auth/AuthProvider';
import { queryClient } from './lib/query';
import { ThemeProvider } from './lib/theme/ThemeProvider';
import { AppRoutes } from './routes';

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <Suspense fallback={<LoadingScreen />}>
              <AppRoutes />
            </Suspense>
          </BrowserRouter>
          <Toaster />
        </QueryClientProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
