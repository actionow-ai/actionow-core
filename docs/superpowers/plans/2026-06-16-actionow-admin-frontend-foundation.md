# Actionow Admin Frontend — Plan 1: Foundation (Shell · Liquid Glass · GSAP · i18n · Themes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a runnable, themeable (dark/light), bilingual (zh-CN | en), GSAP-animated Liquid Glass **app shell** for the Actionow admin console at `apps/admin`, with placeholder routes — zero backend dependency.

**Architecture:** Vite + React 19 + TS SPA. Design tokens as CSS custom properties (dark default + `[data-theme="light"]`). Liquid Glass = a `.glass` utility (backdrop-filter) on chrome; content on near-opaque `--panel-bg`. GSAP drives an ambient cursor-reactive background, the active-nav pill (Flip), and stat count-ups; autonomous motion respects `prefers-reduced-motion`, pointer parallax stays on. i18n via i18next/react-i18next from day one (all copy through `t()`).

**Tech Stack:** Vite, React 19, TypeScript, Tailwind CSS v4 (`@tailwindcss/vite`), GSAP + `@gsap/react` (`useGSAP`, Flip), i18next + react-i18next + browser-languagedetector, React Router v7, TanStack Query v5, Vitest + Testing Library + jsdom.

**Source spec:** `docs/superpowers/specs/2026-06-16-actionow-admin-frontend-design.md` (§4 placement, §5 tokens, §6 glass, §7 GSAP, §8 components, §9 shell, §12 i18n).

---

## Prerequisites & Conventions

- **Branch:** per spec §17.5, implement on a branch cut from the latest backend (`feat/admin-frontend` once rebased onto/after Phase 9–10 land). This plan touches **only `apps/admin`** plus workspace/turbo wiring, so it does not conflict with backend work.
- TDD where it adds value (utils, hooks, stores, i18n parity, component render); pure scaffold/config steps use a build/typecheck/run verification instead of a forced test.
- Strict ESLint (root config applies); no `any`. Commit per task, lowercase conventional subject. Don't push.
- Run all commands from repo root unless noted. Package filter: `pnpm --filter @actionow/admin <script>`.

---

## File Structure (created in this plan)

```
apps/admin/
  package.json · tsconfig.json · vite.config.ts · index.html · .env.example
  src/
    main.tsx · App.tsx · routes.tsx · vite-env.d.ts
    test/setup.ts
    styles/{index.css, theme.css, glass.css}
    i18n/{index.ts, locales/{zh-CN,en}/common.json}
    lib/
      theme/ThemeProvider.tsx
      motion/{gsap.ts, useReducedMotion.ts}
    components/
      glass/{AppBackground.tsx, GlassPanel.tsx, GlassButton.tsx, StatCard.tsx, glass-filters.tsx}
      layout/{AppShell.tsx, NavRail.tsx, SubNav.tsx, TopBar.tsx, ThemeToggle.tsx, LanguageSwitch.tsx, nav-config.ts}
      icons/index.tsx
      feedback/EmptyState.tsx
    features/placeholder/PlaceholderPage.tsx
```

---

## Task 1: Scaffold `apps/admin` (Vite + React + TS + Tailwind v4 + Vitest)

**Files:**
- Create: `apps/admin/package.json`, `apps/admin/tsconfig.json`, `apps/admin/vite.config.ts`, `apps/admin/index.html`, `apps/admin/.env.example`, `apps/admin/src/vite-env.d.ts`, `apps/admin/src/test/setup.ts`, `apps/admin/src/styles/index.css`, `apps/admin/src/main.tsx`, `apps/admin/src/App.tsx`
- Modify (if needed): `pnpm-workspace.yaml`

- [ ] **Step 1: Confirm the workspace globs include `apps/*`**

Run: `cat pnpm-workspace.yaml`
Expected: contains `apps/*` (and `packages/*`). If `apps/*` is missing, add it under `packages:`. Do not remove existing entries.

- [ ] **Step 2: Create `apps/admin/package.json`**

```json
{
  "name": "@actionow/admin",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "@gsap/react": "^2.1.1",
    "@tanstack/react-query": "^5.59.0",
    "gsap": "^3.12.5",
    "i18next": "^23.16.0",
    "i18next-browser-languagedetector": "^8.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-i18next": "^15.1.0",
    "react-router-dom": "^7.1.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@testing-library/jest-dom": "^6.6.0",
    "@testing-library/react": "^16.1.0",
    "@testing-library/user-event": "^14.5.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "jsdom": "^25.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 3: Create `apps/admin/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["vite/client", "vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Create `apps/admin/vite.config.ts`**

```ts
/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const API = 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/admin': API,
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
```

- [ ] **Step 5: Create `apps/admin/index.html`**

```html
<!doctype html>
<html lang="zh-CN" data-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Actionow Admin</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Create supporting files**

`apps/admin/.env.example`:
```
VITE_API_BASE_URL=
VITE_OAUTH_ENABLED=false
```

`apps/admin/src/vite-env.d.ts`:
```ts
/// <reference types="vite/client" />
```

`apps/admin/src/test/setup.ts` (jsdom lacks `matchMedia`; polyfill so theme/reduced-motion code runs):
```ts
import '@testing-library/jest-dom/vitest';

if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}
```

`apps/admin/src/styles/index.css`:
```css
@import 'tailwindcss';
@import './theme.css';
@import './glass.css';
```

`apps/admin/src/App.tsx` (temporary; replaced in Task 9):
```tsx
export default function App() {
  return <div>Actionow Admin</div>;
}
```

`apps/admin/src/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import './styles/index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

Create `apps/admin/src/styles/theme.css` and `glass.css` as empty files for now (filled in Task 2):
```bash
mkdir -p apps/admin/src/styles
: > apps/admin/src/styles/theme.css
: > apps/admin/src/styles/glass.css
```

- [ ] **Step 7: Install and verify build + dev boot**

Run: `pnpm install`
Then: `pnpm --filter @actionow/admin build`
Expected: PASS (tsc + vite build produce `apps/admin/dist`). If `tsc -b` complains about no references, it's fine since `include: ["src"]`.

Run (smoke, then Ctrl-C): `pnpm --filter @actionow/admin dev`
Expected: Vite serves on `http://localhost:5173` showing "Actionow Admin".

- [ ] **Step 8: Commit**

```bash
git add apps/admin pnpm-workspace.yaml
git commit -m "feat(admin): scaffold vite react ts app with tailwind v4 + vitest"
```

---

## Task 2: Design tokens + Liquid Glass utilities (theme.css, glass.css)

**Files:**
- Modify: `apps/admin/src/styles/theme.css`, `apps/admin/src/styles/glass.css`

- [ ] **Step 1: Write `theme.css` (tokens, dark default + light override)**

```css
:root {
  color-scheme: dark;
  --accent: #ffd60a;
  --accent-strong-from: #ffd60a;
  --accent-strong-to: #ff9f0a;
  --ink: #1c1500;

  /* spacing (8px grid) */
  --s-1: 4px; --s-2: 8px; --s-3: 12px; --s-4: 16px; --s-5: 20px; --s-6: 24px; --s-8: 32px;
  /* radii */
  --r-sm: 11px; --r-md: 14px; --r-lg: 18px; --r-pill: 20px;

  /* dark */
  --bg: #0d0c0a;
  --text: #f2efe6;
  --muted: #9a9384;
  --faint: #8f897a;
  --glass-bg: rgba(255, 255, 255, 0.06);
  --glass-bd: rgba(255, 255, 255, 0.12);
  --glass-hl: rgba(255, 255, 255, 0.22);
  --glass-shadow: 0 1px 1px rgba(0, 0, 0, 0.25), 0 12px 28px rgba(0, 0, 0, 0.4);
  --panel-bg: rgba(18, 16, 12, 0.82);
  --panel-bd: rgba(255, 255, 255, 0.07);
  --row-bd: rgba(255, 255, 255, 0.05);
  --b1: rgba(255, 214, 10, 0.55);
  --b2: rgba(251, 146, 60, 0.46);
  --b3: rgba(245, 158, 11, 0.44);
  --spot: rgba(255, 214, 10, 0.28);
  --blur: 60px;

  /* status */
  --ok: #4ade80; --run: #fbbf24; --wait: #fb923c; --fail: #f87171; --idle: #9a9384;
}

[data-theme='light'] {
  color-scheme: light;
  --bg: #f1eee4;
  --text: #272219;
  --muted: #7a7263;
  --faint: #9b927f;
  --glass-bg: rgba(255, 255, 255, 0.55);
  --glass-bd: rgba(0, 0, 0, 0.05);
  --glass-hl: rgba(255, 255, 255, 0.65);
  --glass-shadow: 0 1px 2px rgba(60, 45, 5, 0.05), 0 10px 24px rgba(120, 90, 20, 0.1);
  --panel-bg: rgba(255, 255, 255, 0.66);
  --panel-bd: rgba(0, 0, 0, 0.05);
  --row-bd: rgba(0, 0, 0, 0.045);
  --b1: rgba(255, 193, 7, 0.6);
  --b2: rgba(251, 146, 60, 0.5);
  --b3: rgba(245, 158, 11, 0.48);
  --spot: rgba(255, 176, 10, 0.35);
  --blur: 54px;
  --ok: #16a34a; --run: #d9920a; --wait: #ea7a26; --fail: #dc2626; --idle: #7a7263;
}

* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif;
  transition: background 0.5s ease, color 0.5s ease;
}
.tabular { font-variant-numeric: tabular-nums; }
```

- [ ] **Step 2: Write `glass.css` (glass chrome + content panel)**

```css
.glass {
  background: var(--glass-bg);
  backdrop-filter: blur(22px) saturate(170%);
  -webkit-backdrop-filter: blur(22px) saturate(170%);
  border: 1px solid var(--glass-bd);
  box-shadow: inset 0 1px 0 var(--glass-hl), var(--glass-shadow);
}
.panel {
  background: var(--panel-bg);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid var(--panel-bd);
  box-shadow: var(--glass-shadow);
}
/* accessibility: reduce transparency → near-opaque surfaces */
@media (prefers-reduced-transparency: reduce) {
  .glass { backdrop-filter: none; -webkit-backdrop-filter: none; background: var(--panel-bg); }
  .panel { backdrop-filter: none; -webkit-backdrop-filter: none; }
}
[data-reduce-transparency='true'] .glass {
  backdrop-filter: none; -webkit-backdrop-filter: none; background: var(--panel-bg);
}
[data-reduce-transparency='true'] .panel { backdrop-filter: none; -webkit-backdrop-filter: none; }
```

- [ ] **Step 3: Verify build still passes**

Run: `pnpm --filter @actionow/admin build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/styles
git commit -m "feat(admin): liquid glass design tokens + glass utilities (dark/light)"
```

---

## Task 3: Theme provider + toggle (persist, prefers-color-scheme)

**Files:**
- Create: `apps/admin/src/lib/theme/ThemeProvider.tsx`, `apps/admin/src/components/icons/index.tsx`, `apps/admin/src/components/layout/ThemeToggle.tsx`
- Test: `apps/admin/src/lib/theme/ThemeProvider.test.tsx`

- [ ] **Step 1: Write the failing test**

`apps/admin/src/lib/theme/ThemeProvider.test.tsx`:
```tsx
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';

import { ThemeProvider, useTheme } from './ThemeProvider';

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

function Probe() {
  const { theme, toggle } = useTheme();
  return (
    <button onClick={toggle}>
      theme:{theme}
    </button>
  );
}

test('defaults to dark and applies data-theme to <html>', () => {
  render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
  expect(screen.getByRole('button')).toHaveTextContent('theme:dark');
  expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
});

test('toggle flips theme and persists to localStorage', async () => {
  render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
  await act(async () => {
    await userEvent.click(screen.getByRole('button'));
  });
  expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  expect(localStorage.getItem('actionow.theme')).toBe('light');
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm --filter @actionow/admin test ThemeProvider`
Expected: FAIL — cannot find `./ThemeProvider`.

- [ ] **Step 3: Implement `ThemeProvider.tsx`**

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type Theme = 'dark' | 'light';
const KEY = 'actionow.theme';

function initialTheme(): Theme {
  const saved = localStorage.getItem(KEY);
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

interface ThemeCtx {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}
const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(KEY, theme);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => setThemeState(t), []);
  const toggle = useCallback(
    () => setThemeState((t) => (t === 'dark' ? 'light' : 'dark')),
    [],
  );

  const value = useMemo(() => ({ theme, setTheme, toggle }), [theme, setTheme, toggle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
```

- [ ] **Step 4: Add icon components used across the shell**

`apps/admin/src/components/icons/index.tsx`:
```tsx
type P = { size?: number };
const base = (size: number) => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
});
export const MoonIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8z" /></svg>
);
export const SunIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5 5l1.7 1.7M17.3 17.3L19 19M19 5l-1.7 1.7M6.7 17.3L5 19" /></svg>
);
export const GridIcon = ({ size = 19 }: P) => (
  <svg {...base(size)}><rect x="3" y="3" width="7" height="7" rx="1.6" /><rect x="14" y="3" width="7" height="7" rx="1.6" /><rect x="3" y="14" width="7" height="7" rx="1.6" /><rect x="14" y="14" width="7" height="7" rx="1.6" /></svg>
);
export const BuildingIcon = ({ size = 19 }: P) => (
  <svg {...base(size)}><rect x="5" y="3" width="14" height="18" rx="1.6" /><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2" /></svg>
);
export const KeyIcon = ({ size = 19 }: P) => (
  <svg {...base(size)}><circle cx="8" cy="15" r="4" /><path d="M11 12l8-8 2 2-2 2 2 2-2 2-2-2-2 2" /></svg>
);
export const WalletIcon = ({ size = 19 }: P) => (
  <svg {...base(size)}><rect x="3" y="6" width="18" height="13" rx="2.5" /><path d="M3 10h18M16 14h2" /></svg>
);
export const GearIcon = ({ size = 19 }: P) => (
  <svg {...base(size)}><circle cx="12" cy="12" r="3.2" /><path d="M12 2.6v2.8M12 18.6v2.8M21.4 12h-2.8M5.4 12H2.6M18.6 5.4l-2 2M7.4 16.6l-2 2M18.6 18.6l-2-2M7.4 7.4l-2-2" /></svg>
);
export const ChevronDownIcon = ({ size = 12 }: P) => (
  <svg {...base(size)}><path d="M6 9l6 6 6-6" /></svg>
);
export const PlusIcon = ({ size = 13 }: P) => (
  <svg {...{ ...base(size), strokeWidth: 2.2 }}><path d="M12 5v14M5 12h14" /></svg>
);
export const SearchIcon = ({ size = 13 }: P) => (
  <svg {...base(size)}><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-3.6-3.6" /></svg>
);
export const GlobeIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18" /></svg>
);
```

- [ ] **Step 5: Implement `ThemeToggle.tsx`**

```tsx
import { useTheme } from '../../lib/theme/ThemeProvider';
import { MoonIcon, SunIcon } from '../icons';

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      className="glass"
      style={{
        width: 34, height: 34, borderRadius: '50%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text)', cursor: 'pointer',
      }}
    >
      {theme === 'dark' ? <MoonIcon /> : <SunIcon />}
    </button>
  );
}
```

- [ ] **Step 6: Run the test, verify it passes**

Run: `pnpm --filter @actionow/admin test ThemeProvider`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/lib/theme apps/admin/src/components/icons apps/admin/src/components/layout/ThemeToggle.tsx
git commit -m "feat(admin): theme provider + toggle with persistence"
```

---

## Task 4: i18n (zh-CN | en) + language switch

**Files:**
- Create: `apps/admin/src/i18n/index.ts`, `apps/admin/src/i18n/locales/zh-CN/common.json`, `apps/admin/src/i18n/locales/en/common.json`, `apps/admin/src/components/layout/LanguageSwitch.tsx`
- Test: `apps/admin/src/i18n/i18n.test.ts`

- [ ] **Step 1: Write the failing test (zh/en key parity)**

`apps/admin/src/i18n/i18n.test.ts`:
```ts
import { expect, test } from 'vitest';

import en from './locales/en/common.json';
import zh from './locales/zh-CN/common.json';

function keys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null
      ? keys(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );
}

test('zh-CN and en have identical key sets', () => {
  expect(keys(zh).sort()).toEqual(keys(en).sort());
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm --filter @actionow/admin test i18n`
Expected: FAIL — cannot find `./locales/...`.

- [ ] **Step 3: Create the locale resources**

`apps/admin/src/i18n/locales/zh-CN/common.json`:
```json
{
  "app": { "name": "Actionow 管理台" },
  "nav": {
    "groups": { "ops": "运营", "billing": "计费", "catalog": "目录", "monitor": "监控", "settings": "设置" },
    "dashboard": "仪表盘",
    "tenants": "租户",
    "accounts": "账户 / 充值",
    "apiKeys": "API Keys",
    "ledger": "账本",
    "payments": "支付 / 对账",
    "pricing": "定价",
    "modifiers": "修饰符",
    "resources": "资源目录",
    "dify": "Dify 导入",
    "files": "文件",
    "jobs": "任务",
    "settingsPage": "设置"
  },
  "actions": { "search": "搜索", "newTenant": "新建租户" },
  "theme": { "toLight": "切换到亮色", "toDark": "切换到暗色" },
  "lang": { "label": "语言", "zh": "中文", "en": "English" },
  "common": { "comingSoon": "即将上线", "comingSoonHint": "该模块将在后续阶段提供。" },
  "user": { "menu": "管理员" }
}
```

`apps/admin/src/i18n/locales/en/common.json`:
```json
{
  "app": { "name": "Actionow Admin" },
  "nav": {
    "groups": { "ops": "Operations", "billing": "Billing", "catalog": "Catalog", "monitor": "Monitoring", "settings": "Settings" },
    "dashboard": "Dashboard",
    "tenants": "Tenants",
    "accounts": "Accounts",
    "apiKeys": "API Keys",
    "ledger": "Ledger",
    "payments": "Payments",
    "pricing": "Pricing",
    "modifiers": "Modifiers",
    "resources": "Resources",
    "dify": "Dify Import",
    "files": "Files",
    "jobs": "Jobs",
    "settingsPage": "Settings"
  },
  "actions": { "search": "Search", "newTenant": "New tenant" },
  "theme": { "toLight": "Switch to light", "toDark": "Switch to dark" },
  "lang": { "label": "Language", "zh": "中文", "en": "English" },
  "common": { "comingSoon": "Coming soon", "comingSoonHint": "This module ships in a later phase." },
  "user": { "menu": "Admin" }
}
```

- [ ] **Step 4: Create `i18n/index.ts`**

```ts
import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

import enCommon from './locales/en/common.json';
import zhCommon from './locales/zh-CN/common.json';

export const SUPPORTED = ['zh-CN', 'en'] as const;

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      'zh-CN': { common: zhCommon },
      en: { common: enCommon },
    },
    fallbackLng: 'zh-CN',
    supportedLngs: SUPPORTED as unknown as string[],
    defaultNS: 'common',
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'actionow.lang',
      caches: ['localStorage'],
    },
  });

i18n.on('languageChanged', (lng) => {
  document.documentElement.setAttribute('lang', lng);
});

export default i18n;
```

- [ ] **Step 5: Create `LanguageSwitch.tsx`**

```tsx
import { useTranslation } from 'react-i18next';

import { GlobeIcon } from '../icons';

export function LanguageSwitch() {
  const { i18n, t } = useTranslation();
  const next = i18n.language.startsWith('zh') ? 'en' : 'zh-CN';
  return (
    <button
      type="button"
      onClick={() => void i18n.changeLanguage(next)}
      aria-label={t('lang.label')}
      className="glass"
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 11.5, color: 'var(--text)', cursor: 'pointer',
        padding: '7px 12px', borderRadius: 'var(--r-pill)',
      }}
    >
      <GlobeIcon />
      {next === 'en' ? t('lang.en') : t('lang.zh')}
    </button>
  );
}
```

- [ ] **Step 6: Run the test, verify it passes**

Run: `pnpm --filter @actionow/admin test i18n`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/i18n apps/admin/src/components/layout/LanguageSwitch.tsx
git commit -m "feat(admin): i18n (zh-CN | en) with language switch"
```

---

## Task 5: Motion primitives (`useReducedMotion`, gsap registration)

**Files:**
- Create: `apps/admin/src/lib/motion/gsap.ts`, `apps/admin/src/lib/motion/useReducedMotion.ts`
- Test: `apps/admin/src/lib/motion/useReducedMotion.test.tsx`

- [ ] **Step 1: Write the failing test**

`apps/admin/src/lib/motion/useReducedMotion.test.tsx`:
```tsx
import { renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { useReducedMotion } from './useReducedMotion';

function stubMatch(matches: boolean) {
  window.matchMedia = vi.fn().mockReturnValue({
    matches,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia;
}

test('returns true when reduced motion is preferred', () => {
  stubMatch(true);
  const { result } = renderHook(() => useReducedMotion());
  expect(result.current).toBe(true);
});

test('returns false otherwise', () => {
  stubMatch(false);
  const { result } = renderHook(() => useReducedMotion());
  expect(result.current).toBe(false);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @actionow/admin test useReducedMotion`
Expected: FAIL — cannot find `./useReducedMotion`.

- [ ] **Step 3: Implement both files**

`apps/admin/src/lib/motion/useReducedMotion.ts`:
```ts
import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia(QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}
```

`apps/admin/src/lib/motion/gsap.ts`:
```ts
import { useGSAP } from '@gsap/react';
import { gsap } from 'gsap';
import { Flip } from 'gsap/Flip';

gsap.registerPlugin(useGSAP, Flip);

export { Flip, gsap, useGSAP };
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm --filter @actionow/admin test useReducedMotion`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/lib/motion
git commit -m "feat(admin): gsap registration + useReducedMotion hook"
```

---

## Task 6: `AppBackground` (aurora blobs + cursor parallax + spotlight)

**Files:**
- Create: `apps/admin/src/components/glass/AppBackground.tsx`
- Test: `apps/admin/src/components/glass/AppBackground.test.tsx`

- [ ] **Step 1: Write the failing test (renders structure, no crash on mount)**

`apps/admin/src/components/glass/AppBackground.test.tsx`:
```tsx
import { render } from '@testing-library/react';
import { expect, test } from 'vitest';

import { AppBackground } from './AppBackground';

test('renders three blobs and a spotlight', () => {
  const { container } = render(<AppBackground />);
  expect(container.querySelectorAll('[data-blob]')).toHaveLength(3);
  expect(container.querySelector('[data-spot]')).not.toBeNull();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @actionow/admin test AppBackground`
Expected: FAIL — cannot find `./AppBackground`.

- [ ] **Step 3: Implement `AppBackground.tsx`**

```tsx
import { useRef } from 'react';

import { gsap, useGSAP } from '../../lib/motion/gsap';
import { useReducedMotion } from '../../lib/motion/useReducedMotion';

const BLOBS = [
  { key: 'b1', size: 340, css: { left: -60, top: -80 }, color: 'var(--b1)', depth: 0.1, idle: [26, -18, 7] },
  { key: 'b2', size: 300, css: { right: -40, top: 20 }, color: 'var(--b2)', depth: -0.07, idle: [-22, 20, 8.5] },
  { key: 'b3', size: 300, css: { left: '36%', bottom: -110 }, color: 'var(--b3)', depth: 0.05, idle: [18, 24, 6.2] },
] as const;

export function AppBackground() {
  const root = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  useGSAP(
    () => {
      const el = root.current;
      if (!el) return;
      const blobs = BLOBS.map((b) => el.querySelector<HTMLElement>(`[data-blob="${b.key}"]`));
      const spot = el.querySelector<HTMLElement>('[data-spot]');

      // idle breathing on inner element (autonomous → gated by reduced motion)
      if (!reduced) {
        BLOBS.forEach((b, i) => {
          const inner = blobs[i]?.firstElementChild;
          if (inner) {
            gsap.to(inner, {
              x: b.idle[0], y: b.idle[1], duration: b.idle[2],
              ease: 'sine.inOut', yoyo: true, repeat: -1,
            });
          }
        });
      }

      // pointer parallax + spotlight (user-driven → always on)
      const qx = blobs.map((b) => (b ? gsap.quickTo(b, 'x', { duration: 0.9, ease: 'power3.out' }) : null));
      const qy = blobs.map((b) => (b ? gsap.quickTo(b, 'y', { duration: 0.9, ease: 'power3.out' }) : null));
      const sx = spot ? gsap.quickTo(spot, 'x', { duration: 0.5, ease: 'power3.out' }) : null;
      const sy = spot ? gsap.quickTo(spot, 'y', { duration: 0.5, ease: 'power3.out' }) : null;

      const onMove = (e: PointerEvent) => {
        const r = el.getBoundingClientRect();
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        if (px < 0 || py < 0 || px > r.width || py > r.height) return;
        if (spot) gsap.to(spot, { opacity: 1, duration: 0.3 });
        sx?.(px - 210);
        sy?.(py - 210);
        const dx = px - r.width / 2;
        const dy = py - r.height / 2;
        BLOBS.forEach((b, i) => {
          qx[i]?.(dx * b.depth);
          qy[i]?.(dy * b.depth);
        });
      };
      const onLeave = () => {
        if (spot) gsap.to(spot, { opacity: 0, duration: 0.5 });
        BLOBS.forEach((_, i) => {
          qx[i]?.(0);
          qy[i]?.(0);
        });
      };
      document.addEventListener('pointermove', onMove);
      el.addEventListener('pointerleave', onLeave);
      return () => {
        document.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerleave', onLeave);
      };
    },
    { scope: root, dependencies: [reduced] },
  );

  return (
    <div
      ref={root}
      aria-hidden="true"
      style={{ position: 'fixed', inset: 0, overflow: 'hidden', zIndex: 0, pointerEvents: 'none' }}
    >
      {BLOBS.map((b) => (
        <div
          key={b.key}
          data-blob={b.key}
          style={{ position: 'absolute', width: b.size, height: b.size, willChange: 'transform', ...b.css }}
        >
          <div
            style={{
              width: '100%', height: '100%', borderRadius: '50%',
              filter: 'blur(var(--blur))',
              background: `radial-gradient(circle, ${b.color}, transparent 70%)`,
            }}
          />
        </div>
      ))}
      <div
        data-spot
        style={{
          position: 'absolute', width: 420, height: 420, left: 0, top: 0, opacity: 0, willChange: 'transform',
          borderRadius: '50%', filter: 'blur(28px)',
          background: 'radial-gradient(circle, var(--spot), transparent 65%)',
        }}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm --filter @actionow/admin test AppBackground`
Expected: PASS. (gsap tweens are created but jsdom won't animate; the test asserts DOM structure only.)

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/components/glass/AppBackground.tsx apps/admin/src/components/glass/AppBackground.test.tsx
git commit -m "feat(admin): liquid ambient background with cursor parallax + spotlight"
```

---

## Task 7: Glass primitives (`GlassPanel`, `GlassButton`, `StatCard`)

**Files:**
- Create: `apps/admin/src/components/glass/GlassPanel.tsx`, `apps/admin/src/components/glass/GlassButton.tsx`, `apps/admin/src/components/glass/StatCard.tsx`
- Test: `apps/admin/src/components/glass/StatCard.test.tsx`

- [ ] **Step 1: Write the failing test (StatCard renders final value under reduced motion)**

`apps/admin/src/components/glass/StatCard.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

vi.mock('../../lib/motion/useReducedMotion', () => ({ useReducedMotion: () => true }));

import { StatCard } from './StatCard';

test('renders the label and final formatted value (reduced motion = no animation)', () => {
  render(<StatCard label="Tenants" value={3402} />);
  expect(screen.getByText('Tenants')).toBeInTheDocument();
  expect(screen.getByText('3,402')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @actionow/admin test StatCard`
Expected: FAIL — cannot find `./StatCard`.

- [ ] **Step 3: Implement the three components**

`apps/admin/src/components/glass/GlassPanel.tsx`:
```tsx
import type { CSSProperties, ReactNode } from 'react';

export function GlassPanel({
  children,
  className = '',
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={`glass ${className}`} style={{ borderRadius: 'var(--r-md)', ...style }}>
      {children}
    </div>
  );
}
```

`apps/admin/src/components/glass/GlassButton.tsx`:
```tsx
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'glass' | 'cta';

export function GlassButton({
  children,
  variant = 'glass',
  style,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; children: ReactNode }) {
  const cta = variant === 'cta';
  return (
    <button
      {...rest}
      className={cta ? '' : 'glass'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontSize: 12, fontWeight: cta ? 650 : 500,
        padding: '7px 13px', borderRadius: 'var(--r-pill)', cursor: 'pointer',
        color: cta ? 'var(--ink)' : 'var(--text)',
        background: cta ? 'var(--accent)' : undefined,
        border: cta ? 'none' : undefined,
        boxShadow: cta ? '0 4px 14px rgba(255,176,10,.4)' : undefined,
        ...style,
      }}
    >
      {children}
    </button>
  );
}
```

`apps/admin/src/components/glass/StatCard.tsx`:
```tsx
import { useRef } from 'react';

import { gsap, useGSAP } from '../../lib/motion/gsap';
import { useReducedMotion } from '../../lib/motion/useReducedMotion';

function format(v: number, suffix?: string): string {
  const dec = v % 1 !== 0;
  return (dec ? v.toFixed(1) : Math.round(v).toLocaleString()) + (suffix ?? '');
}

export function StatCard({
  label,
  value,
  suffix,
  delta,
}: {
  label: string;
  value: number;
  suffix?: string;
  delta?: { text: string; tone?: 'up' | 'amber' };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  useGSAP(
    () => {
      const el = ref.current?.querySelector<HTMLElement>('[data-num]');
      if (!el) return;
      if (reduced) {
        el.textContent = format(value, suffix);
        return;
      }
      const o = { v: 0 };
      gsap.to(o, {
        v: value, duration: 1.1, ease: 'power2.out',
        onUpdate: () => {
          el.textContent = format(o.v, suffix);
        },
      });
    },
    { scope: ref, dependencies: [value, reduced] },
  );

  return (
    <div ref={ref} className="glass" style={{ padding: 'var(--s-4)', borderRadius: 'var(--r-md)' }}>
      <div style={{ fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted)' }}>
        {label}
      </div>
      <div data-num className="tabular" style={{ fontSize: 24, fontWeight: 700, marginTop: 8, letterSpacing: '-.02em' }}>
        {reduced ? format(value, suffix) : '0'}
      </div>
      {delta && (
        <div style={{ fontSize: 10.5, marginTop: 6, color: delta.tone === 'amber' ? 'var(--run)' : 'var(--ok)' }}>
          {delta.text}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm --filter @actionow/admin test StatCard`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/components/glass
git commit -m "feat(admin): glass panel, button, and animated stat card"
```

---

## Task 8: App shell (NavRail · SubNav with Flip pill · TopBar · AppShell)

**Files:**
- Create: `apps/admin/src/components/layout/nav-config.ts`, `NavRail.tsx`, `SubNav.tsx`, `TopBar.tsx`, `AppShell.tsx`
- Test: `apps/admin/src/components/layout/AppShell.test.tsx`

- [ ] **Step 1: Create `nav-config.ts` (data only)**

```ts
import type { ComponentType } from 'react';

import { BuildingIcon, GearIcon, GridIcon, WalletIcon } from '../icons';

export interface NavItem {
  /** route path */
  to: string;
  /** i18n key under `nav` */
  labelKey: string;
}
export interface NavGroup {
  /** top-level rail group; i18n key under `nav.groups` */
  key: string;
  icon: ComponentType<{ size?: number }>;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    key: 'ops', icon: GridIcon,
    items: [
      { to: '/dashboard', labelKey: 'dashboard' },
      { to: '/tenants', labelKey: 'tenants' },
    ],
  },
  {
    key: 'billing', icon: WalletIcon,
    items: [
      { to: '/accounts', labelKey: 'accounts' },
      { to: '/ledger', labelKey: 'ledger' },
      { to: '/payments', labelKey: 'payments' },
    ],
  },
  {
    key: 'catalog', icon: BuildingIcon,
    items: [{ to: '/resources', labelKey: 'resources' }],
  },
  {
    key: 'settings', icon: GearIcon,
    items: [{ to: '/api-keys', labelKey: 'apiKeys' }],
  },
];

/** which group owns a given pathname (defaults to the first group) */
export function groupForPath(pathname: string): NavGroup {
  return NAV.find((g) => g.items.some((it) => pathname.startsWith(it.to))) ?? NAV[0];
}
```

- [ ] **Step 2: Create `NavRail.tsx`**

```tsx
import { useNavigate } from 'react-router-dom';

import { groupForPath, NAV } from './nav-config';

export function NavRail({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const active = groupForPath(pathname);
  return (
    <div
      className="glass"
      style={{
        width: 56, borderRadius: 'var(--r-lg)',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: 'var(--s-3)', padding: 'var(--s-4) 0',
      }}
    >
      {NAV.map((g) => {
        const Icon = g.icon;
        const on = g.key === active.key;
        return (
          <button
            key={g.key}
            type="button"
            aria-label={g.key}
            aria-current={on ? 'true' : undefined}
            onClick={() => navigate(g.items[0].to)}
            style={{
              width: 36, height: 36, borderRadius: 'var(--r-sm)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none',
              color: on ? 'var(--ink)' : 'var(--muted)',
              background: on ? 'linear-gradient(135deg, var(--accent-strong-from), var(--accent-strong-to))' : 'transparent',
              boxShadow: on ? '0 4px 14px rgba(255,176,10,.45), inset 0 1px 0 rgba(255,255,255,.5)' : undefined,
            }}
          >
            <Icon />
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Create `SubNav.tsx` (active pill slides via GSAP)**

```tsx
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';

import { gsap, useGSAP } from '../../lib/motion/gsap';
import { useReducedMotion } from '../../lib/motion/useReducedMotion';
import { groupForPath } from './nav-config';

export function SubNav({ pathname }: { pathname: string }) {
  const { t } = useTranslation();
  const group = groupForPath(pathname);
  const root = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  useGSAP(
    () => {
      const el = root.current;
      const pill = el?.querySelector<HTMLElement>('[data-pill]');
      const activeLink = el?.querySelector<HTMLElement>('a[aria-current="page"]');
      if (!el || !pill || !activeLink) return;
      gsap.to(pill, {
        y: activeLink.offsetTop,
        height: activeLink.offsetHeight,
        duration: reduced ? 0 : 0.45,
        ease: 'power3.out',
      });
    },
    { scope: root, dependencies: [pathname, group.key, reduced] },
  );

  return (
    <div
      ref={root}
      className="glass"
      style={{ width: 178, borderRadius: 'var(--r-lg)', padding: 'var(--s-4) var(--s-3)', position: 'relative' }}
    >
      <div
        data-pill
        style={{
          position: 'absolute', top: 0, left: 'var(--s-3)', right: 'var(--s-3)', height: 34,
          borderRadius: 'var(--r-sm)', background: 'rgba(255,214,10,.13)',
          border: '1px solid rgba(255,214,10,.28)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.12)', zIndex: 0,
        }}
      />
      <div style={{ fontSize: 9, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--faint)', margin: '0 var(--s-2) 6px' }}>
        {t(`nav.groups.${group.key}`)}
      </div>
      {group.items.map((it) => (
        <NavLink
          key={it.to}
          to={it.to}
          style={({ isActive }) => ({
            position: 'relative', zIndex: 1, display: 'block',
            padding: '9px 10px', borderRadius: 'var(--r-sm)', marginBottom: 2,
            fontSize: 12.5, textDecoration: 'none',
            color: isActive ? 'var(--text)' : 'var(--muted)',
          })}
        >
          {t(`nav.${it.labelKey}`)}
        </NavLink>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Create `TopBar.tsx`**

```tsx
import { useTranslation } from 'react-i18next';

import { ChevronDownIcon } from '../icons';
import { LanguageSwitch } from './LanguageSwitch';
import { ThemeToggle } from './ThemeToggle';

export function TopBar({ title }: { title: string }) {
  const { t } = useTranslation();
  return (
    <div
      className="glass"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: 'var(--s-3) var(--s-4)', borderRadius: 'var(--r-md)',
      }}
    >
      <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-.01em' }}>{title}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
        <LanguageSwitch />
        <ThemeToggle />
        <span
          className="glass"
          style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, padding: '7px 12px', borderRadius: 'var(--r-pill)' }}
        >
          {t('user.menu')}
          <ChevronDownIcon />
        </span>
      </span>
    </div>
  );
}
```

- [ ] **Step 5: Create `AppShell.tsx`**

```tsx
import { useTranslation } from 'react-i18next';
import { Outlet, useLocation } from 'react-router-dom';

import { AppBackground } from '../glass/AppBackground';
import { NavRail } from './NavRail';
import { groupForPath } from './nav-config';
import { SubNav } from './SubNav';
import { TopBar } from './TopBar';

export function AppShell() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const group = groupForPath(pathname);
  const active = group.items.find((it) => pathname.startsWith(it.to)) ?? group.items[0];
  const title = t(`nav.${active.labelKey}`);

  return (
    <>
      <AppBackground />
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', gap: 'var(--s-3)', padding: 'var(--s-4)', height: '100vh' }}>
        <NavRail pathname={pathname} />
        <SubNav pathname={pathname} />
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
          <TopBar title={title} />
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            <Outlet />
          </div>
        </main>
      </div>
    </>
  );
}
```

- [ ] **Step 6: Write the shell test**

`apps/admin/src/components/layout/AppShell.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeAll, expect, test } from 'vitest';

import i18n from '../../i18n';
import { AppShell } from './AppShell';

beforeAll(async () => {
  // jsdom's navigator.language could resolve i18n to `en`; force zh-CN for a
  // deterministic assertion on the Chinese label.
  await i18n.changeLanguage('zh-CN');
});

test('renders rail groups, the active group sub-nav, and the page title', () => {
  render(
    <MemoryRouter initialEntries={['/accounts']}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/accounts" element={<div>accounts-page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  // billing group is active → its sub-nav shows the Accounts link (zh-CN default)
  expect(screen.getAllByText('账户 / 充值').length).toBeGreaterThan(0);
  expect(screen.getByText('accounts-page')).toBeInTheDocument();
});
```

- [ ] **Step 7: Run the test, verify it passes**

Run: `pnpm --filter @actionow/admin test AppShell`
Expected: PASS. (If i18n init is async, the default zh-CN bundled resources are synchronous, so labels render immediately.)

- [ ] **Step 8: Commit**

```bash
git add apps/admin/src/components/layout
git commit -m "feat(admin): app shell — nav rail, sub-nav flip pill, top bar"
```

---

## Task 9: Routing + placeholder pages + wired `App`

**Files:**
- Create: `apps/admin/src/features/placeholder/PlaceholderPage.tsx`, `apps/admin/src/components/feedback/EmptyState.tsx`, `apps/admin/src/routes.tsx`
- Modify: `apps/admin/src/App.tsx`, `apps/admin/src/main.tsx`

- [ ] **Step 1: Create `EmptyState.tsx`**

```tsx
import type { ReactNode } from 'react';

export function EmptyState({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div
      className="panel"
      style={{
        height: '100%', borderRadius: 'var(--r-md)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 8, color: 'var(--muted)',
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{title}</div>
      {hint && <div style={{ fontSize: 12 }}>{hint}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Create `PlaceholderPage.tsx`**

```tsx
import { useTranslation } from 'react-i18next';

import { EmptyState } from '../../components/feedback/EmptyState';

export function PlaceholderPage() {
  const { t } = useTranslation();
  return <EmptyState title={t('common.comingSoon')} hint={t('common.comingSoonHint')} />;
}
```

- [ ] **Step 3: Create `routes.tsx`**

```tsx
import { Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from './components/layout/AppShell';
import { PlaceholderPage } from './features/placeholder/PlaceholderPage';

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<PlaceholderPage />} />
        <Route path="/tenants" element={<PlaceholderPage />} />
        <Route path="/accounts" element={<PlaceholderPage />} />
        <Route path="/api-keys" element={<PlaceholderPage />} />
        <Route path="/ledger" element={<PlaceholderPage />} />
        <Route path="/payments" element={<PlaceholderPage />} />
        <Route path="/resources" element={<PlaceholderPage />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Routes>
  );
}
```

- [ ] **Step 4: Replace `App.tsx`**

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Suspense } from 'react';
import { BrowserRouter } from 'react-router-dom';

import { ThemeProvider } from './lib/theme/ThemeProvider';
import { AppRoutes } from './routes';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

export default function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Suspense fallback={null}>
            <AppRoutes />
          </Suspense>
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
```

- [ ] **Step 5: Update `main.tsx` to import i18n before render**

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import './i18n';
import './styles/index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 6: Verify build + run**

Run: `pnpm --filter @actionow/admin build`
Expected: PASS.

Run (smoke, then Ctrl-C): `pnpm --filter @actionow/admin dev`
Expected: `http://localhost:5173` shows the Liquid Glass shell — icon rail + sub-nav + top bar, dark by default; moving the mouse drifts the aurora + spotlight; theme toggle flips dark/light; language switch toggles zh/en; clicking rail groups / sub-nav items routes and slides the pill; content area shows the "即将上线 / Coming soon" placeholder.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/routes.tsx apps/admin/src/App.tsx apps/admin/src/main.tsx apps/admin/src/features apps/admin/src/components/feedback
git commit -m "feat(admin): routing + placeholder pages wired into the shell"
```

---

## Task 10: Verification gate (typecheck · lint · build · test) + turbo wiring

**Files:**
- Verify only; possibly Modify: `turbo.json` (only if admin scripts aren't picked up)

- [ ] **Step 1: Confirm turbo picks up the new app**

Run: `cat turbo.json`
Expected: `build`/`lint`/`test`/`typecheck` tasks are defined globally; since `@actionow/admin` declares those scripts, `turbo run <task>` includes it automatically. If `turbo.json` pins a package list, add `@actionow/admin`. Otherwise no change.

- [ ] **Step 2: Run the full admin gate**

Run: `pnpm --filter @actionow/admin typecheck`
Expected: PASS (no type errors).

Run: `pnpm --filter @actionow/admin lint`
Expected: PASS. Fix any ESLint errors (e.g., import order via `simple-import-sort`) until clean. **Likely needed:** the root `eslint.config.mjs` targets server/Node packages, so add an override block for `apps/admin/**` that sets `languageOptions.globals` to browser globals (so `window`/`document`/`localStorage` aren't `no-undef`), keeps `simple-import-sort`, and — if React-specific lint isn't already present — leaves JSX alone (the react-jsx runtime needs no `React` import). Mirror the existing per-area override style in that file; do not weaken rules for other packages.

Run: `pnpm --filter @actionow/admin test`
Expected: PASS — ThemeProvider (2), i18n (1), useReducedMotion (2), AppBackground (1), StatCard (1), AppShell (1).

Run: `pnpm --filter @actionow/admin build`
Expected: PASS.

- [ ] **Step 3: Run the root gate (ensures admin joins the monorepo pipelines)**

Run: `pnpm turbo run typecheck lint build --filter=@actionow/admin`
Expected: PASS for `@actionow/admin`.

- [ ] **Step 4: Commit any fixups**

```bash
git add -A
git commit -m "chore(admin): foundation verification gate green"
```

---

## Plan 1 Definition of Done

- `apps/admin` is a runnable Vite + React + TS SPA in the monorepo (`pnpm --filter @actionow/admin dev/build/test/typecheck/lint` all green).
- Liquid Glass design tokens (dark default + light), `.glass`/`.panel` utilities, reduce-transparency fallback.
- Theme provider/toggle (persisted, honors `prefers-color-scheme`); language switch (zh-CN | en) with key-parity test; all shell copy via `t()`.
- GSAP-driven ambient background (cursor parallax + spotlight, idle drift gated by reduced-motion), animated stat card (count-up), and Flip-style active-nav pill.
- App shell (icon rail + sub-nav + top bar) with React Router routes and placeholder pages.

> **Next:** Plan 2 — Auth (`/auth/login` + `role==='admin'` gate, protected routes) + Data layer (typed API client, error envelope, `Money` µcredit util, `useKeyset`). Then Plan 3 — MVP screens (Dashboard, Tenants, Accounts + top-up, API Keys) using coss primitives.
```
