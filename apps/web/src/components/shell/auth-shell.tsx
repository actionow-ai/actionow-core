import { TooltipProvider } from '@/components/ui/components/animate/tooltip';

import { Brand } from './brand';
import { ThemeButton } from './theme-button';

function AuthShell({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <TooltipProvider openDelay={250}>
      <div className="min-h-[100dvh] bg-background">
        <header className="flex h-16 items-center justify-between px-5 sm:px-8">
          <Brand />
          <ThemeButton />
        </header>
        <main className="grid min-h-[calc(100dvh-4rem)] place-items-center px-4 py-10">
          <div className="w-full max-w-md">
            <div className="mb-7">
              {eyebrow ? <p className="text-sm font-medium text-primary">{eyebrow}</p> : null}
              <h1 className="mt-2 text-3xl font-semibold tracking-[-0.045em]">{title}</h1>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
            </div>
            {children}
          </div>
        </main>
      </div>
    </TooltipProvider>
  );
}

export { AuthShell };
