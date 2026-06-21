# Actionow Web — Conventions

## Design tokens (single source of truth: `src/styles/theme.css`)

- **Type:** all `fontSize` must reference `--fs-*` (`--fs-nano` 9 · `--fs-micro` 10 · `--fs-caption` 11 · `--fs-sm` 13 · `--fs-base` 15 · `--fs-md` 16 · `--fs-lg` 18 · `--fs-h2`/`--fs-h1`/`--fs-display` · `--fs-xl` 24 · `--fs-2xl` 30). No bare numbers; no re-inlined `clamp()` for headings.
- **Spacing/radius:** `--s-*`, `--r-xs/sm/md/lg/pill`. No magic px.
- **Color:** never blue (incl. hover/focus/active). Warm `--accent`/`--accent-2` only. Vendor brand logos are the sole color exception. No emoji — Phosphor `*Icon` only.
- **Shadows/gradient:** use `--glass-shadow`, `--shadow-lift`, `--shadow-cta*`, `--shadow-accent-*`, `--glow-accent*`, `--grad-accent`, `--scrim`. No ad-hoc rgba shadows.
- **Theme:** dark default + `[data-theme='light']`; every component must read tokens so both themes work.

## Motion

- Tokens: CSS `--dur-*`/`--ease-*`; GSAP mirror `lib/motion/tokens.ts` (`DUR`/`EASE`); `gsap.defaults` set in `lib/motion/gsap.ts`.
- GSAP: always inside `useGSAP({ scope, dependencies })`. **Never** call `ScrollTrigger.getAll().kill()` — rely on `useGSAP` auto-revert.
- Reduced motion is default-respected (see L3).

## Responsive

- Breakpoints come from `lib/breakpoints.ts` (`BP.sm` 640 · `BP.md` 768 · `BP.wide` 880 · `BP.lg` 960 · `BP.xl` 1100 · `BP.xxl` 1280 — the last for master-detail side-by-side). No inline `(min-width: …)` literals.
- Layout via inline styles + CSS vars (not Tailwind utilities).

## (Filled by later layers)

- L1 — data & caching: centralized query keys, cache-policy tiers, `keepPreviousData`, URL-as-truth for filters/tabs, `mutationError(t)`.
- L2 — components: `onChange(value)` contract, `FormField`, a11y (keyboard rows / Modal focus trap / Select keys), variant/size naming.
- L3 — motion details.
