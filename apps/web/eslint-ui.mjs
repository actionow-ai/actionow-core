// graphite ESLint UI 约束(与 scripts/check-ui.mjs 双保险)。
// 消费方用法(flat config):
//   import { nativeControlRestrictions, vendoredUiOverrides } from './eslint-ui.mjs';
//   { files: ['src/pages/**/*.tsx', 'src/components/**/*.tsx'],
//     ignores: ['src/components/ui/**'],
//     rules: { 'no-restricted-syntax': ['error', ...nativeControlRestrictions()] } },
//   vendoredUiOverrides('src/components/ui'),
export function nativeControlRestrictions() {
  return ['button', 'input', 'select', 'textarea', 'dialog'].map((name) => ({
    selector: `JSXOpeningElement[name.name='${name}']`,
    message: `业务界面禁止直接使用原生 ${name}，请使用 components/ui 中的封装。`,
  }));
}

// vendored ui 层混合导出组件与工具，关闭 react-refresh 检查。
export function vendoredUiOverrides(uiRoot) {
  return {
    files: [
      `${uiRoot}/{components,icons,primitives}/**/*.tsx`,
      `${uiRoot}/*.tsx`,
    ],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  };
}
