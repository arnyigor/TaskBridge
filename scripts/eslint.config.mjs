// Минимальный плоский конфиг: разбор web/*.js без изменения кода (P0 аудит).
//
// Глобальные объекты разделены по средам: Node-код (src, scripts, tests, cloud)
// получает только Node-имена, браузерные файлы — браузерные. Общий список
// «на всякий случай» отключал бы no-undef там, где он ловит настоящие опечатки.
import js from '@eslint/js';

const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
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

const rules = { ...js.configs.recommended.rules };

export default [
  {
    files: ['src/**/*.mjs', 'scripts/**/*.mjs', 'tests/**/*.mjs', 'cloud/**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: nodeGlobals },
    rules,
  },
  {
    files: ['web/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: browserGlobals },
    rules,
  },
  {
    files: ['web/sw.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: workerGlobals },
    rules,
  },
];
