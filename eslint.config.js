// @ts-check
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // 项目使用 React 18：渲染期同步 ref 保持最新值、effect 内 setState
      // 均为合法模式，react-hooks v7 的两条新规则面向 React 19，关闭
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      // 下划线前缀表示有意忽略（与现有代码惯例一致）
      '@typescript-eslint/no-unused-vars': [
        'error',
        { varsIgnorePattern: '^_', argsIgnorePattern: '^_' },
      ],
      // 仅组件导出使用 react-refresh，非组件模块导出不报警
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  // 测试文件：mock 数据使用 any 是惯用法，放宽该规则
  {
    files: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  // 关闭与 Prettier 冲突的格式规则（交给 Prettier 处理）
  prettier,
)
