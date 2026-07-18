import { motion, useReducedMotion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { getSession, sessionPayload } from '@/api/auth';
import { Brand } from '@/components/shell/brand';
import { LanguageButton } from '@/components/shell/language-button';
import { ThemeButton } from '@/components/shell/theme-button';
import { TooltipProvider } from '@/components/ui/components/animate/tooltip';
import { Button } from '@/components/ui/components/buttons/button';
import { Card } from '@/components/ui/data-display';
import { ArrowRightIcon } from '@/components/ui/icons/arrow-right';
import { CircleCheckBigIcon } from '@/components/ui/icons/circle-check-big';
import { config } from '@/config';
import { DURATION, EASE_OUT } from '@/lib/motion';

// 动效节拍：分段延迟与逐行 stagger 均由 motion.ts 常量推导，不写裸时长。
const STEP_DELAY = DURATION.fast / 2;
const LINE_STAGGER = DURATION.fast / 2;

const requestLines = [
  { indent: false, prompt: true, text: 'curl -X POST https://your-gateway/v1/chat/completions \\' },
  { indent: true, prompt: false, text: '-H "Authorization: Bearer ak_..." \\' },
  { indent: true, prompt: false, text: '-d \'{ "model": "gpt-4o-mini", "messages": [...] }\'' },
];

const responseLines = [
  '{',
  '  "choices": [{ "message": { "content": "..." } }],',
  '  "usage": { "prompt_tokens": 128, "total_tokens": 512 }',
  '}',
];

// 终端演示卡：data-theme="dark" 强制暗色孤岛，卡内全部走 token，不写裸色值。
function CodePanel() {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const reveal = (index: number) =>
    reduceMotion
      ? {}
      : {
          initial: { opacity: 0, x: -6 },
          animate: { opacity: 1, x: 0 },
          transition: {
            duration: DURATION.base,
            delay: DURATION.base + index * LINE_STAGGER,
            ease: EASE_OUT,
          },
        };

  return (
    <Card
      data-theme="dark"
      initial={reduceMotion ? false : { opacity: 0, y: 16, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: DURATION.slow, delay: DURATION.fast, ease: EASE_OUT }}
      className="hidden overflow-hidden rounded-2xl bg-surface text-foreground shadow-overlay lg:block"
    >
      <div className="flex items-center gap-1.5 px-5 pt-4" aria-hidden="true">
        <span className="size-2.5 rounded-full bg-foreground/25" />
        <span className="size-2.5 rounded-full bg-foreground/25" />
        <span className="size-2.5 rounded-full bg-foreground/25" />
      </div>
      <pre className="overflow-x-auto p-5 pt-3 font-mono text-[12.5px] leading-[1.7]">
        <code className="grid">
          {requestLines.map((line, index) => (
            <motion.span
              key={line.text}
              {...reveal(index)}
              className={line.indent ? 'pl-6' : undefined}
            >
              {line.prompt ? <span className="text-muted-foreground">$ </span> : null}
              {line.text}
            </motion.span>
          ))}
          <motion.span {...reveal(requestLines.length)} className="mt-3 text-muted-foreground">
            {t('landing.codeComment')}
          </motion.span>
          {responseLines.map((line, index) => (
            <motion.span key={line} {...reveal(requestLines.length + 1 + index)}>
              {line.includes('total_tokens') ? (
                <>
                  {'  "usage": { "prompt_tokens": 128, "total_tokens": '}
                  <span className="text-success">512</span>
                  {' }'}
                </>
              ) : (
                line
              )}
            </motion.span>
          ))}
        </code>
      </pre>
    </Card>
  );
}

// 单屏营销页：header / hero / 三步 / CTA 条共享一根 100dvh 列。桌面不滚动；
// 代码卡 lg 以下隐藏、三步行 md 以下隐藏，小屏由 main 兜底滚动。
export function LandingPage() {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const rise = (step: number) =>
    reduceMotion
      ? {}
      : {
          initial: { opacity: 0, y: 14 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: DURATION.slow, delay: step * STEP_DELAY, ease: EASE_OUT },
        };

  const signedIn = getSession() !== null;
  const consoleHref = sessionPayload()?.role === 'admin' ? '/console/overview' : '/app/overview';
  // Signed-out primary CTA promises "create account" → open /login in register mode.
  const primaryTo = signedIn ? consoleHref : '/login?mode=register';
  const primaryLabel = signedIn ? t('landing.enterConsole') : t('landing.createAccount');

  const steps = [
    { number: '01', title: t('landing.step1Title'), body: t('landing.step1Body') },
    { number: '02', title: t('landing.step2Title'), body: t('landing.step2Body') },
    { number: '03', title: t('landing.step3Title'), body: t('landing.step3Body') },
  ];
  const points = [t('landing.point1'), t('landing.point2'), t('landing.point3')];

  return (
    <TooltipProvider openDelay={250}>
      <div className="flex h-dvh flex-col bg-background">
        <header className="mx-auto flex h-14 w-full max-w-6xl shrink-0 items-center justify-between px-5 sm:h-16 sm:px-8">
          <Brand />
          <nav className="flex items-center gap-1.5" aria-label={t('common.mainNavigation')}>
            <LanguageButton />
            <ThemeButton />
            <Button asChild variant="ghost">
              <Link to="/login">{t('landing.login')}</Link>
            </Button>
            <Button asChild className="hidden sm:inline-flex">
              <Link to={primaryTo}>{primaryLabel}</Link>
            </Button>
          </nav>
        </header>

        <main className="mx-auto min-h-0 w-full max-w-6xl flex-1 overflow-y-auto px-6 sm:px-10 lg:px-16">
          <div className="flex min-h-full flex-col justify-center gap-[clamp(1rem,3vh,2.25rem)] py-5">
            <section className="grid shrink-0 items-center gap-8 lg:grid-cols-[1.02fr_minmax(0,0.98fr)] lg:gap-14">
              <div>
                <motion.h1
                  {...rise(0)}
                  className="text-[clamp(1.9rem,3.2vh+1.1rem,3.3rem)] leading-[1.08] font-semibold tracking-[-0.045em]"
                >
                  {t('landing.title1')}
                  <br />
                  {t('landing.title2')}
                </motion.h1>
                <motion.p
                  {...rise(1)}
                  className="mt-[clamp(0.75rem,2vh,1.5rem)] max-w-lg text-[15px] leading-relaxed text-muted-foreground"
                >
                  {t('landing.subtitle')}
                </motion.p>
                <motion.div
                  {...rise(2)}
                  className="mt-[clamp(1rem,2.6vh,2rem)] flex flex-wrap items-center gap-3"
                >
                  <Button asChild size="lg" className="h-11 px-6 text-[15px] sm:h-12">
                    <Link to={primaryTo}>
                      {primaryLabel}
                      <ArrowRightIcon animateOnHover />
                    </Link>
                  </Button>
                  <Button
                    asChild
                    size="lg"
                    variant="outline"
                    className="h-11 px-6 text-[15px] sm:h-12"
                  >
                    <Link to="/login">{t('landing.signInConsole')}</Link>
                  </Button>
                </motion.div>
                <motion.ul {...rise(3)} className="mt-[clamp(1rem,2.6vh,2rem)] grid gap-2.5">
                  {points.map((point) => (
                    <li
                      key={point}
                      className="flex items-center gap-2.5 text-sm text-muted-foreground"
                    >
                      <span className="text-success">
                        <CircleCheckBigIcon animateOnView={!reduceMotion} size={16} />
                      </span>
                      {point}
                    </li>
                  ))}
                </motion.ul>
              </div>
              <CodePanel />
            </section>

            <motion.section
              {...rise(3.5)}
              className="hidden shrink-0 grid-cols-3 gap-8 border-t pt-[clamp(1rem,2.6vh,1.75rem)] md:grid"
            >
              {steps.map((step) => (
                <div key={step.number}>
                  <p className="font-mono text-xs text-muted-foreground/70">{step.number}</p>
                  <h2 className="mt-1.5 text-base font-semibold tracking-[-0.02em]">
                    {step.title}
                  </h2>
                  <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-muted-foreground">
                    {step.body}
                  </p>
                </div>
              ))}
            </motion.section>

            <Card
              data-theme="dark"
              {...rise(4)}
              className="flex shrink-0 flex-col items-start justify-between gap-4 rounded-2xl bg-surface px-6 py-5 text-foreground shadow-overlay sm:flex-row sm:items-center sm:px-8"
            >
              <div>
                <h2 className="text-lg font-semibold tracking-[-0.025em] sm:text-xl">
                  {t('landing.ctaTitle')}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">{t('landing.ctaBody')}</p>
              </div>
              <Button asChild size="lg" className="h-11 shrink-0 px-6 text-[15px]">
                <Link to="/login?mode=register">
                  {t('landing.createAccount')}
                  <ArrowRightIcon animateOnHover />
                </Link>
              </Button>
            </Card>
          </div>
        </main>

        <footer className="mx-auto flex h-11 w-full max-w-6xl shrink-0 items-center justify-between gap-3 border-t px-5 text-xs text-muted-foreground sm:px-8">
          <p>2026 {config.brandName}</p>
          <Link className="rounded transition-colors hover:text-foreground" to="/login">
            {t('landing.footerSignIn')}
          </Link>
        </footer>
      </div>
    </TooltipProvider>
  );
}
