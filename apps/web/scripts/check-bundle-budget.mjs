import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

// 构建产物预算守卫。用法: node scripts/check-bundle-budget.mjs [--dist dist]
// 预算为 graphite 默认值；消费方按产品需要调整下面四个常量。
const distArgIndex = process.argv.indexOf('--dist');
const DIST_ROOT = path.resolve(distArgIndex === -1 ? 'dist' : process.argv[distArgIndex + 1]);
const INDEX_PATH = path.join(DIST_ROOT, 'index.html');

// 本项目上调 JS/total 预算（graphite 默认 192/208KB）：双控制台 37 页的 zh+en 文案
// 随 i18n init 进入口 chunk（约 +30KB gzip），无运行时依赖泄漏（contracts 全部
// import type）。若未来入口再涨，优先做按需 locale 拆分而不是继续调此值。
const MAX_INITIAL_JS_GZIP_BYTES = 256 * 1024;
const MAX_INITIAL_CSS_GZIP_BYTES = 16 * 1024;
const MAX_INITIAL_TOTAL_GZIP_BYTES = 272 * 1024;
const MAX_MODULE_PRELOADS = 2;

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1];
}

function localAssetPath(reference) {
  if (!reference?.startsWith('/assets/')) {
    throw new Error(`initial asset must use a local /assets/ path: ${reference ?? 'missing'}`);
  }
  const resolved = path.resolve(DIST_ROOT, reference.slice(1));
  if (!resolved.startsWith(`${DIST_ROOT}${path.sep}`)) {
    throw new Error('initial asset escaped the dist directory');
  }
  return resolved;
}

function gzipBytes(reference) {
  return gzipSync(readFileSync(localAssetPath(reference)), { level: 9 }).byteLength;
}

const html = readFileSync(INDEX_PATH, 'utf8');
const scriptTags = html.match(/<script\b[^>]*\bsrc="[^"]+"[^>]*>/g) ?? [];
const linkTags = html.match(/<link\b[^>]*>/g) ?? [];
const entryScripts = scriptTags.map((tag) => attribute(tag, 'src'));
const modulePreloads = linkTags
  .filter((tag) => attribute(tag, 'rel') === 'modulepreload')
  .map((tag) => attribute(tag, 'href'));
const stylesheets = linkTags
  .filter((tag) => attribute(tag, 'rel') === 'stylesheet')
  .map((tag) => attribute(tag, 'href'));

if (entryScripts.length !== 1) {
  throw new Error(`expected exactly one initial module script, found ${entryScripts.length}`);
}
if (modulePreloads.length > MAX_MODULE_PRELOADS) {
  throw new Error(
    `modulepreload budget exceeded: ${modulePreloads.length} > ${MAX_MODULE_PRELOADS}`,
  );
}
if (modulePreloads.some((reference) => reference.includes('overlay-vendor'))) {
  throw new Error('route-only overlay-vendor must not be preloaded by the initial document');
}

const initialJavaScript = [...new Set([...entryScripts, ...modulePreloads])];
const initialStylesheets = [...new Set(stylesheets)];
const initialJsGzipBytes = initialJavaScript.reduce(
  (total, reference) => total + gzipBytes(reference),
  0,
);
const initialCssGzipBytes = initialStylesheets.reduce(
  (total, reference) => total + gzipBytes(reference),
  0,
);
const initialTotalGzipBytes = initialJsGzipBytes + initialCssGzipBytes;

const report = {
  initial_css_gzip_bytes: initialCssGzipBytes,
  initial_js_gzip_bytes: initialJsGzipBytes,
  initial_total_gzip_bytes: initialTotalGzipBytes,
  modulepreload_count: modulePreloads.length,
  budgets: {
    initial_css_gzip_bytes: MAX_INITIAL_CSS_GZIP_BYTES,
    initial_js_gzip_bytes: MAX_INITIAL_JS_GZIP_BYTES,
    initial_total_gzip_bytes: MAX_INITIAL_TOTAL_GZIP_BYTES,
    modulepreload_count: MAX_MODULE_PRELOADS,
  },
};

console.log(JSON.stringify(report));

const failures = [
  ['initial JS gzip', initialJsGzipBytes, MAX_INITIAL_JS_GZIP_BYTES],
  ['initial CSS gzip', initialCssGzipBytes, MAX_INITIAL_CSS_GZIP_BYTES],
  ['initial total gzip', initialTotalGzipBytes, MAX_INITIAL_TOTAL_GZIP_BYTES],
].filter(([, actual, maximum]) => actual > maximum);

if (failures.length > 0) {
  for (const [name, actual, maximum] of failures) {
    console.error(`${name} budget exceeded: ${actual} > ${maximum}`);
  }
  process.exitCode = 1;
}
