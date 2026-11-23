// Плоский конфиг ESLint для TaskBridge: только правила, которые ловят РЕАЛЬНЫЕ
// падения в рантайме (забытый импорт, дублирующийся метод, присваивание константе),
// и ничего про форматирование — иначе 170 существующих файлов утонули бы в
// предупреждениях и правило перестали бы читать.
//
// Почему это здесь, а не в корне: в репозитории действует allowlist корневых файлов
// (scripts/repo-paths.mjs), и новый файл в корне — отдельное решение, а не привычка.
//
// Глобальные объекты разделены по средам: Node-код (src, scripts, tests, api, cloud,
// bin, pi-extension) получает только Node-имена, браузерные файлы — браузерные.
// Общий список «на всякий случай» отключал бы no-undef там, где он ловит опечатки.
import js from '@eslint/js';

const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  AbortSignal: 'readonly',
  AbortController: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  crypto: 'readonly',
  performance: 'readonly',
  structuredClone: 'readonly',
  queueMicrotask: 'readonly',
  // Web-платформенные имена, которые Node 22 отдаёт глобально: их используют тесты
  // (загрузка файлов, WebSocket-каналы) и серверные SSE-обёртки.
  FormData: 'readonly',
  Blob: 'readonly',
  File: 'readonly',
  Headers: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  WebSocket: 'readonly',
  atob: 'readonly',
  btoa: 'readonly',
  // CommonJS-совместимые имена: конфиг разбирает и их.
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  __dirname: 'readonly',
  __filename: 'readonly',
};

const browserGlobals = {
  ...nodeGlobals,
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  history: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  alert: 'readonly',
  confirm: 'readonly',
  prompt: 'readonly',
  atob: 'readonly',
  btoa: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  addEventListener: 'readonly',
  removeEventListener: 'readonly',
  Notification: 'readonly',
  EventSource: 'readonly',
  FormData: 'readonly',
  File: 'readonly',
  Blob: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  Headers: 'readonly',
  DataTransfer: 'readonly',
  IntersectionObserver: 'readonly',
  ResizeObserver: 'readonly',
  MutationObserver: 'readonly',
  DOMParser: 'readonly',
  Image: 'readonly',
  self: 'readonly',
};

/** The service worker runs in a worker scope: `self`, `caches`, `clients`, `skipWaiting`. */
const workerGlobals = {
  ...browserGlobals,
  caches: 'readonly',
  clients: 'readonly',
  registration: 'readonly',
  skipWaiting: 'readonly',
  importScripts: 'readonly',
};

// Только правила-ловцы багов. `no-unused-vars` — ПРЕДУПРЕЖДЕНИЕ: в проекте есть
// осознанно оставленные заготовки, и падать из-за них CI не должен.
const BUG_RULES = {
  'no-undef': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-duplicate-case': 'error',
  'no-const-assign': 'error',
  'no-import-assign': 'error',
  'no-func-assign': 'error',
  'no-class-assign': 'error',
  'no-redeclare': 'error',
  'no-self-assign': 'error',
  'no-unreachable': 'error',
  'no-unsafe-negation': 'error',
  'no-loss-of-precision': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-unused-vars': ['warn', {
    args: 'none',
    caughtErrors: 'none',
    varsIgnorePattern: '^_',
  }],
};

export default [
  {
    ignores: [
      'node_modules/**',
      'data/**',
      'clients/**',
      'dump/**',
      '.local/**',
      'deliverables/**',
      'web/vendor/**',
      // Собранные сторонние бандлы (DOMPurify в облачной раздаче): внутри чужие
      // eslint-disable-комментарии для плагинов, которых в проекте нет.
      'cloud/public/vendor/**',
      '**/*.min.js',
    ],
  },
  // Сервер, CLI, скрипты, расширения Pi, тесты и облако (Node 22 ESM).
  {
    files: [
      'src/**/*.mjs',
      'scripts/**/*.mjs',
      'tests/**/*.mjs',
      'bin/**/*.mjs',
      'api/**/*.mjs',
      'cloud/**/*.mjs',
      'pi-extension/**/*.js',
    ],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: nodeGlobals },
    rules: BUG_RULES,
  },
  // Веб-клиент: ESM-модули (app.js, chat-state.mjs, transport.mjs, …).
  {
    files: ['web/**/*.js', 'web/**/*.mjs'],
    ignores: ['web/sw.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: browserGlobals },
    rules: BUG_RULES,
  },
  // Классические скрипты в web/ (без import/export).
  {
    files: ['web/cloud-config.js', 'web/providers.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: browserGlobals },
    rules: BUG_RULES,
  },
  // Service worker.
  {
    files: ['web/sw.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: workerGlobals },
    rules: BUG_RULES,
  },
];
