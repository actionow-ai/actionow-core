// UI 政策检查：1) 业务层禁止原生交互控件(强制走 components/ui 封装)；2) 全源码禁 emoji。
// 用法(消费方项目, 零参数默认): node scripts/check-ui.mjs
//   默认 --source src --business src/pages --business src/components --ignore src/components/ui
// 用法(自定义): node scripts/check-ui.mjs --source <dir> --business <dir> --ignore <dir> (均可多次)
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function collectArg(name) {
  const values = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === `--${name}` && process.argv[i + 1]) values.push(process.argv[i + 1]);
  }
  return values;
}

const sourceRoots = (collectArg('source').length > 0 ? collectArg('source') : ['src']).map((p) => path.resolve(p));
const businessRoots = (collectArg('business').length > 0
  ? collectArg('business')
  : [path.join('src', 'pages'), path.join('src', 'components')]
).map((p) => path.resolve(p));
const ignoreRoots = (collectArg('ignore').length > 0
  ? collectArg('ignore')
  : [path.join('src', 'components', 'ui')]
).map((p) => path.resolve(p));

const nativeControlPattern = /<(button|input|select|textarea|dialog)(?=[\s>])/gu;
const emojiPattern = /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
const sourceExtensions = new Set(['.ts', '.tsx', '.css', '.html']);

function ignored(file) {
  return ignoreRoots.some((root) => file === root || file.startsWith(`${root}${path.sep}`));
}

async function filesIn(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.name === 'node_modules') return [];
      return entry.isDirectory() ? filesIn(entryPath) : [entryPath];
    }),
  );
  return files.flat();
}

const allSourceFiles = (await Promise.all(sourceRoots.map(filesIn)))
  .flat()
  .filter((file) => sourceExtensions.has(path.extname(file)));
const businessFiles = (await Promise.all(businessRoots.map(filesIn)))
  .flat()
  .filter((file) => file.endsWith('.tsx') && !ignored(file));
const failures = [];

for (const file of businessFiles) {
  const source = await readFile(file, 'utf8');
  const matches = [...source.matchAll(nativeControlPattern)].map((match) => match[1]);
  if (matches.length > 0) failures.push(`${path.relative(process.cwd(), file)}: 原生交互控件 ${matches.join(', ')}`);
}

for (const file of allSourceFiles) {
  const source = await readFile(file, 'utf8');
  if (emojiPattern.test(source)) failures.push(`${path.relative(process.cwd(), file)}: 检测到 emoji`);
  emojiPattern.lastIndex = 0;
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('UI policy checks passed.');
