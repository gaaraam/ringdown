import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config(
  { ignores: ['node_modules/**', 'runs/**'] },
  { ...js.configs.recommended, files: ['web/**/*.js', 'tests/**/*.js', 'scripts/**/*.mjs', 'eslint.config.js'] },
  ...ts.configs.recommended.map(config => ({ ...config, files: ['src/**/*.ts', 'scripts/**/*.ts', 'tests/**/*.ts'] })),
  { files: ['src/**/*.ts', 'scripts/**/*.ts', 'tests/**/*.ts'], rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  } },
  { files: ['tests/**/*.js'], languageOptions: { globals: { structuredClone: 'readonly' } } },
  // Existing schema mutation fixtures deliberately accept invalid shapes.
  { files: ['tests/pack.test.ts'], rules: { '@typescript-eslint/no-explicit-any': 'off' } },
  { files: ['web/**/*.js'], languageOptions: { globals: Object.fromEntries(['document', 'window', 'localStorage', 'fetch', 'FormData', 'URLSearchParams', 'EventSource', 'setTimeout', 'clearTimeout'].map(name => [name, 'readonly'])) } },
  { files: ['scripts/**/*.mjs'], languageOptions: { globals: Object.fromEntries(['process', 'console', 'Buffer', 'URL', 'setTimeout', 'clearTimeout', 'fetch', 'document', 'innerWidth', 'requestAnimationFrame', 'Image', 'OffscreenCanvas'].map(name => [name, 'readonly'])) } },
);
