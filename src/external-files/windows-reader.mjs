import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const externalError = (code = 'FILE_FORBIDDEN') => Object.assign(new Error(({
  FILE_FORBIDDEN: 'Доступ к внешнему файлу запрещён.',
  BODY_TOO_LARGE: 'Файл превышает лимит 2 МиБ.',
  INPUT_INVALID: 'Недопустимый запрос внешнего файла.',
  NOT_FOUND: 'Внешний ресурс не найден.',
  NOT_CONFIGURED: 'Безопасное чтение доступно только на Windows.',
  REVISION_CONFLICT: 'Разрешения изменились. Обновите состояние.',
})[code] || 'Операция с внешним файлом не выполнена.'), { code });

const script = fileURLToPath(new URL('./windows-reader.ps1', import.meta.url));
let active = 0;
/** Fail closed on unsupported hosts; do not substitute realpath -> readFile. */
export async function windowsRead(request, { signal } = {}) {
  if (process.platform !== 'win32') throw externalError('NOT_CONFIGURED');
  if (active >= 4) throw externalError();
  active++;
  try {
    return await new Promise((resolve, reject) => {
      const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      let output = '';
      let size = 0;
      let failed = false;
      const abort = () => { failed = true; child.kill(); };
      const timer = setTimeout(abort, 15000);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        size += Buffer.byteLength(chunk);
        if (size > 4 * 1024 * 1024) return abort();
        output += chunk;
      });
      child.stdin.on('error', () => {});
      child.on('error', () => { failed = true; });
      child.on('close', code => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        try {
          const result = JSON.parse(output.replace(/^\uFEFF/, ''));
          if (failed || code !== 0 || result.error) throw externalError(result.error === 'BODY_TOO_LARGE' ? result.error : 'FILE_FORBIDDEN');
          resolve(result);
        } catch (error) { reject(error.code ? error : externalError()); }
      });
      child.stdin.end(JSON.stringify(request));
    });
  } finally { active--; }
}
