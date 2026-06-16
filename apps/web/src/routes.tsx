import { Navigate, Route, Routes } from 'react-router-dom';

import { LandingPage } from './features/landing/LandingPage';
import { Placeholder } from './features/placeholder/Placeholder';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      {/* Console + login land from the admin plans (Plans 1-3). */}
      <Route path="/login" element={<Placeholder />} />
      <Route path="/console/*" element={<Placeholder />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
