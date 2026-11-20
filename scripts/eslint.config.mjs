// Минимальный плоский конфиг: разбор web/*.js без изменения кода (P0 аудит).
import js from '@eslint/js';

export default [
  {
    files: ['web/**/*.js', 'scripts/**/*.mjs', 'src/**/*.mjs', 'tests/**/*.mjs', 'cloud/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { console: 'readonly', process: 'readonly', window: 'readonly', document: 'readonly', setTimeout: 'readonly', setInterval: 'readonly', clearTimeout: 'readonly', fetch: 'readonly', navigator: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly', location: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', AbortSignal: 'readonly', TextDecoder: 'readonly', btoa: 'readonly', crypto: 'readonly', performance: 'readonly', Notification: 'readonly', navigator: 'readonly', import: 'readonly', require: 'readonly', module: 'writable', exports: 'writable', Buffer: 'readonly', fs: 'readonly', path: 'readonly' },
    },
    rules: { ...js.configs.recommended.rules },
  },
];
