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

## Console page layout (decided 2026-07-07, from the ops + access/models audits)

These settle the recurring "which value" questions the two design audits surfaced. New console pages follow them; drift is a bug, not a style choice.

- **Width cap.** Console **list** pages stay full-bleed (data tables scan better edge-to-edge); do NOT apply `--content-max`. **Detail / reading-form** pages cap at `--content-detail` (960px) — the shared `DetailScaffold` already does this; a bespoke form page (e.g. `PlatformSettingsPage`) sets `maxWidth: 'var(--content-detail)'` on its root. `--content-max` (1200px) is landing-only.
- **Page header.** Never render an in-page `<h1>` on a list page — the title + subtitle come from the shell `TopBar` (driven by `nav-config` `labelKey`). Publish page actions/filters into the TopBar via `useSetConsoleAction` / `useSetConsoleFilters`. (`StatusPage` was the lone violator; keep new pages aligned.)
- **Filter bars.** The sticky ops filter bar is the shared `components/console/StickyFilterBar` (`Z.sticky` / `--z-sticky` = 10) — never re-inline the `.panel` + `position:sticky` block. Inline-labelled filter cells use `InlineFilterField` (real `<label htmlFor>`, never placeholder-as-label).
- **Filter persistence.** Filters, the active sub-tab, and search that a user would want to share or bookmark go through `useUrlState` (URL as truth), not `useState`. A transient in-form draft may stay in `useState`.
- **`DataTable` column contract.** Pill / chip / badge cells set `noClip: true`. Count / latency / price cells set `numeric: true` (right-align + tabular). Give exactly ONE column `grow` (the identity column), width the rest; a bare `—` column must never be the accidental elastic one. A table that owns its own scroll region (sticky header) passes `fill`.
- **Three states.** Every query surface shows loading / empty / error. Reads go through `QueryBoundary` or `DataTable`'s built-in states; never `data ?? []` a failed query into a silent empty/zero. An editor form that seeds from a query disables Save until the query settles (an unseeded save clobbers).
- **Pagination page size.** `pageSize` 25 for catalog-scale lists, 20 for detail sub-tables; keyset lists use `LoadMore`. A picker that has no `LoadMore` of its own must drain all pages in its client method (see `listSecrets`).
- **Create surface.** A table-row/inline create opens a `Drawer`; a short, self-contained create (paste-auth, a 2–3 field form) opens a `Modal`. Keep one convention per entity.
- **Destructive actions.** An irreversible delete (incl. soft-delete that hides the row) uses `TrashIcon` + a `danger` `ConfirmDialog` whose confirm label matches the row verb — never a `ProhibitIcon` (reads as a reversible toggle) or a mismatched generic 删除.

### Open follow-ups (need their own plan / design review)

- **Editor convergence (C5).** `ChannelEditor` should group its connection triple (endpoint / proxy / credential) and both editors should share error-summary + collapse behaviour. Deferred — changes operator muscle memory, so route through `tc-design-review`.
- **`resource` delete (C3).** Platforms are append-only (no `DELETE /admin/resources/:id`; a mis-created text PK is permanent). Whether to add a delete + its cascade semantics is an open decision.
- **Credential rotation (B3).** Rotating a credential's secret material is new-create + repoint + revoke today; a first-class `rotate` endpoint needs crypto + contract design.
