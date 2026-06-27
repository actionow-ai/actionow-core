#!/usr/bin/env node
/**
 * Design-token guard for the web app (apps/web).
 *
 * The codebase themes entirely through CSS custom properties (`--x`) consumed as
 * `var(--x)` — overwhelmingly from inline `style={{}}` props, which stylelint
 * cannot see. This script closes the two gaps that surfaced in the quality audit:
 *
 *  1. UNDEFINED TOKEN REFERENCES (hard error) — every `var(--x)` must resolve to
 *     a token declared somewhere (theme.css/glass.css/index.css, or an inline
 *     `'--x':` style). A reference with no declaration silently inherits the
 *     parent value (the `--fs-h3` render bug) or quietly falls back. This is the
 *     real bug class and fails the build.
 *
 *  2. RAW HEX / rgba IN COMPONENT INLINE STYLES (warning) — a color literal in a
 *     `.tsx` inline style bypasses the token layer and won't follow the theme.
 *     Reported as a warning (some are legitimate brand constants); annotate an
 *     intentional one with a trailing `/* token-exempt *\/` comment to silence it.
 *
 * Zero dependencies; runs under plain Node. Wired into lint-staged, pre-push and CI.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'apps/web/src');

/** Recursively collect files under `dir` whose name matches `exts`. */
function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

const files = walk(SRC, ['.css', '.ts', '.tsx']);

// --- 1. Collect every DECLARED token ---------------------------------------
// CSS declarations: `--x:` at a property position. Inline JS declarations in
// style objects: `'--x':` or `"--x":`. Both forms define a token for consumers.
const declared = new Set();
const DECL_CSS = /(--[\w-]+)\s*:/g; // CSS property + inline `'--x':` style object
const DECL_SETPROP = /setProperty\(\s*['"`](--[\w-]+)/g; // el.style.setProperty('--x', …)
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(DECL_CSS)) declared.add(m[1]);
  for (const m of text.matchAll(DECL_SETPROP)) declared.add(m[1]);
}

// --- 2. Collect every REFERENCED token + flag undefined --------------------
const REF = /var\(\s*(--[\w-]+)/g;
const HEX = /#[0-9a-fA-F]{3,8}\b/;
const RGBA = /\brgba?\(/;

const undefinedRefs = [];
const rawColorWarnings = [];

for (const f of files) {
  const text = readFileSync(f, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(REF)) {
      if (!declared.has(m[1])) {
        undefinedRefs.push({ file: relative(ROOT, f), line: i + 1, token: m[1] });
      }
    }
    // Raw color literals only matter inside .tsx inline styles, and only when not
    // explicitly exempted. CSS files are the token home, so they're skipped.
    if (f.endsWith('.tsx') && !line.includes('token-exempt')) {
      const inStyleish = /(background|color|border|fill|stroke|boxShadow|outline|shadow)/i.test(line);
      if (inStyleish && (HEX.test(line) || RGBA.test(line))) {
        rawColorWarnings.push({ file: relative(ROOT, f), line: i + 1, text: line.trim() });
      }
    }
  });
}

let failed = false;

if (undefinedRefs.length > 0) {
  failed = true;
  console.error(`\n✖ ${undefinedRefs.length} reference(s) to UNDECLARED design tokens:\n`);
  for (const r of undefinedRefs) console.error(`  ${r.file}:${r.line}  ${r.token}`);
  console.error('\n  Declare the token in apps/web/src/styles/theme.css (or fix the typo).');
}

if (rawColorWarnings.length > 0) {
  console.warn(`\n⚠ ${rawColorWarnings.length} raw color literal(s) in component inline styles (prefer a token; add /* token-exempt */ if intentional):\n`);
  for (const w of rawColorWarnings.slice(0, 40)) console.warn(`  ${w.file}:${w.line}`);
  if (rawColorWarnings.length > 40) console.warn(`  …and ${rawColorWarnings.length - 40} more`);
}

if (failed) {
  console.error('\nDesign-token check FAILED.\n');
  process.exit(1);
}
console.log(`✓ design tokens: ${declared.size} declared, all var(--…) references resolve.`);
