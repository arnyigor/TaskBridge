// Один ответ модели через сам Pi (`pi --print`), без сессии и без инструментов.
//
// Зачем: подписочные провайдеры (ChatGPT/Codex и подобные) авторизуются через OAuth
// внутри Pi и адреса chat-completions не имеют. В чате такая модель отвечает, а прямой
// HTTP-запрос к ней упирается в «у провайдера нет адреса» — живой отчёт 2026-10-27.
// Единственный корректный путь к той же модели и тому же доступу — сам Pi.
//
// Всё, что делает процесс безопасным для этой задачи, задано флагами: без сессии (не
// пишет историю), без инструментов (не может ничего изменить), без MCP, расширений,
// скиллов и контекстных файлов проекта (не читает AGENTS.md и не поднимает серверы).

import { spawn } from 'node:child_process';

export const PI_ONESHOT_FLAGS = Object.freeze([
  '--print', '--no-session', '--no-tools', '--no-mcp', '--no-extensions',
  '--no-skills', '--no-context-files', '--no-prompt-templates'
]);

/** Сообщение короткое и без пробелов: всё задание уходит файлом, см. ниже. */
export const PI_ONESHOT_MESSAGE = 'Выполни.';

/** Исполняемый файл: на Windows PATH приводит к pi.cmd, и запускать надо через shell. */
export const PI_ONESHOT_BIN = 'pi';

/**
 * Аргументы запуска. Текст задания передаётся файлом (`--append-system-prompt`), а не
 * аргументом: документ содержит кавычки и переводы строк, и командная строка Windows
 * этого не переживает.
 */
export function piOneShotArgs({ provider = '', model = '', promptFile = '', message = PI_ONESHOT_MESSAGE } = {}) {
  const id = String(model || '').includes('/') ? String(model) : `${provider}/${model}`;
  return [...PI_ONESHOT_FLAGS, '--model', id, '--append-system-prompt', promptFile, message];
}

const quote = value => `"${String(value).replace(/"/g, '""')}"`;

/**
 * Запуск через оболочку: на Windows `pi` — это `pi.cmd`, и spawn без shell его не
 * находит. Аргументы собираются в строку с кавычками сами, потому что shell-режим
 * Node склеивает их через пробел без экранирования.
 */
export function spawnPi(argv, options = {}) {
  // Сам исполняемый файл добавляется здесь, а не вызывающим кодом: без него
  // командная строка начиналась с флага, cmd отвечал «--print не является
  // внутренней командой», и это выглядело как отказ провайдера (живой прогон
  // 2026-10-27, ответ за 251 мс).
  const line = [PI_ONESHOT_BIN, ...argv].map(item => quote(item)).join(' ');
  return spawn(line, {
    shell: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  });
}
