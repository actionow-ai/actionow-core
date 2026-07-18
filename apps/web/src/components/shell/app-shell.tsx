import { CircleUserRound, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router-dom';

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/components/animate/tooltip';
import { Button } from '@/components/ui/components/buttons/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/components/radix/sheet';
import { LogOutIcon } from '@/components/ui/icons/log-out';
import { MenuIcon } from '@/components/ui/icons/menu';
import { cn } from '@/lib/utils';

import { Brand } from './brand';
import { LanguageButton } from './language-button';
import { ThemeButton } from './theme-button';

export interface ShellNavItem {
  label: string;
  to: string;
  icon: React.ReactNode;
  end?: boolean;
}

export interface ShellNavGroup {
  title?: string;
  items: ShellNavItem[];
}

export interface ShellUser {
  name: string;
  detail?: string;
}

// 品牌定制走单通道：直接修改 brand.tsx（logo 与名称），不提供 brand prop——
// 移动顶栏、侧栏、抽屉与 AuthShell 因此永远一致。
export interface AppShellProps {
  navigation: ShellNavGroup[];
  headerStart?: React.ReactNode;
  headerActions?: React.ReactNode;
  user?: ShellUser;
  onLogout?: () => void;
  children?: React.ReactNode;
}

const COLLAPSE_KEY = 'graphite.sidebar-collapsed';

function Navigation({ items, collapsed = false }: { items: ShellNavItem[]; collapsed?: boolean }) {
  const { t } = useTranslation();
  return (
    <nav className="grid gap-1" aria-label={t('common.mainNavigation')}>
      {items.map((item) => {
        const link = (
          <NavLink
            to={item.to}
            end={item.end}
            aria-label={collapsed ? item.label : undefined}
            className={cn(
              // A string (not a function) className: Radix Slot from <TooltipTrigger asChild> in the
              // collapsed rail clobbers a function className, which would drop `relative` and let the
              // active pill escape its item and fill the whole rail. Active styling is applied below.
              'group relative flex h-10 items-center rounded-full text-sm font-medium text-muted-foreground outline-hidden transition-colors hover:bg-surface-strong hover:text-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              collapsed ? 'justify-center px-0' : 'gap-3 px-4',
            )}
          >
            {({ isActive }) => (
              <>
                {isActive ? (
                  <span className="absolute inset-0 rounded-full bg-primary shadow-xs" />
                ) : null}
                <span
                  className={cn(
                    'relative z-10 flex items-center',
                    collapsed ? '' : 'gap-3',
                    isActive ? 'text-primary-foreground' : '',
                  )}
                >
                  {item.icon}
                  {collapsed ? null : <span>{item.label}</span>}
                </span>
              </>
            )}
          </NavLink>
        );
        return collapsed ? (
          <Tooltip key={item.to} side="right" sideOffset={8}>
            <TooltipTrigger asChild>{link}</TooltipTrigger>
            <TooltipContent>{item.label}</TooltipContent>
          </Tooltip>
        ) : (
          <React.Fragment key={item.to}>{link}</React.Fragment>
        );
      })}
    </nav>
  );
}

function SidebarContent({
  navigation,
  user,
  onLogout,
  collapsed = false,
  onToggle,
}: {
  navigation: ShellNavGroup[];
  user?: ShellUser;
  onLogout?: () => void;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col">
      <div
        className={cn(
          'flex h-16 items-center',
          collapsed ? 'justify-center px-2' : 'justify-between px-4',
        )}
      >
        {collapsed ? null : <Brand />}
        {onToggle ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={collapsed ? t('common.expandSidebar') : t('common.collapseSidebar')}
            onClick={onToggle}
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4" />
            ) : (
              <PanelLeftClose className="size-4" />
            )}
          </Button>
        ) : null}
      </div>
      <div className={cn('flex-1 overflow-y-auto py-3', collapsed ? 'px-2' : 'px-3')}>
        {navigation.map((group, index) => (
          <React.Fragment key={group.title ?? index}>
            {index > 0 ? <div className="my-4 h-px bg-border" /> : null}
            {collapsed || !group.title ? null : (
              <p className="px-3 pb-2 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                {group.title}
              </p>
            )}
            <Navigation items={group.items} collapsed={collapsed} />
          </React.Fragment>
        ))}
      </div>
      {user || onLogout ? (
        <div className="p-3">
          {collapsed ? (
            <div className="flex flex-col items-center gap-2">
              <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <CircleUserRound className="size-4" />
              </span>
              {onLogout ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('common.logout')}
                  onClick={onLogout}
                >
                  <LogOutIcon animateOnHover />
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="flex items-center gap-3 rounded-lg px-2 py-2">
              <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <CircleUserRound className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{user?.name ?? t('common.user')}</p>
                <p className="truncate text-xs text-muted-foreground">{user?.detail ?? ''}</p>
              </div>
              {onLogout ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('common.logout')}
                  onClick={onLogout}
                >
                  <LogOutIcon animateOnHover />
                </Button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function AppShell({
  navigation,
  headerStart,
  headerActions,
  user,
  onLogout,
  children,
}: AppShellProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = React.useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleSidebar = React.useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  return (
    <TooltipProvider openDelay={250}>
      <div className="min-h-[100dvh] bg-background">
        <a
          href="#main-content"
          className="sr-only z-[60] rounded-full bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
        >
          {t('common.skipToContent')}
        </a>
        <aside
          className={cn(
            'fixed inset-y-0 left-0 z-20 hidden border-r border-border bg-surface-subtle/55 backdrop-blur-xl transition-[width] duration-200 lg:block',
            collapsed ? 'w-[68px]' : 'w-64',
          )}
        >
          <SidebarContent
            navigation={navigation}
            user={user}
            onLogout={onLogout}
            collapsed={collapsed}
            onToggle={toggleSidebar}
          />
        </aside>
        <div className={collapsed ? 'lg:pl-[68px]' : 'lg:pl-64'}>
          <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-3 bg-background/88 px-4 backdrop-blur-xl sm:px-6 lg:px-8">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="flex items-center gap-2 lg:hidden">
                <Sheet>
                  <SheetTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label={t('common.openNavigation')}>
                      <MenuIcon animateOnHover />
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="left" showCloseButton>
                    <SheetHeader className="sr-only">
                      <SheetTitle>{t('common.mainNavigation')}</SheetTitle>
                    </SheetHeader>
                    <SidebarContent navigation={navigation} user={user} onLogout={onLogout} />
                  </SheetContent>
                </Sheet>
                <Brand compact />
              </div>
              {headerStart}
            </div>
            <div className="flex items-center gap-1">
              <LanguageButton />
              <ThemeButton />
              {headerActions}
            </div>
          </header>
          <main id="main-content" className="px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
            {children ?? <Outlet />}
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}

export { AppShell };
