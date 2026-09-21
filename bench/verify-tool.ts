import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

/**
 * Два инструмента проверки для агента:
 *
 *   repro  — «воспроизведи симптом»: прогоняет пользовательский сценарий и ждёт
 *            ПАДЕНИЯ. Отвечает на вопрос «я вообще увидел то, о чём жалуется
 *            пользователь». Без него агент принимает понимание кода за проверку.
 *   verify — «проверь, что ушло»: тот же сценарий, но ждёт, что НЕ падает.
 *
 * Зачем инструментами, а не просьбой: замерено, что пока проверка на устройстве была
 * строкой в системном промпте, за три прогона было 0 обращений к устройству; как
 * только она стала инструментом — 31 обращение и доведённый до конца фикс.
 *
 * Настройка: BENCH_APP (id приложения), BENCH_SCENARIO (путь к сценарию),
 * BENCH_VERIFY_TIMEOUT_MS. Отчёты каждого вызова пишутся в ./reports рядом.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = process.env.BENCH_SCENARIO ?? path.join(here, 'verify-scenario.mjs');
const APP = process.env.BENCH_APP ?? '';
const TIMEOUT_MS = Number(process.env.BENCH_VERIFY_TIMEOUT_MS ?? 420000);
const REPORTS = path.join(here, 'reports');

interface Verdict {
  verdict?: string;
  reasons?: string[];
  evidence?: Record<string, string | null>;
  steps?: string[];
}

function execScenario(args: string[], signal?: AbortSignal) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, args, { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024, signal },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number' ? Number((error as { code?: number }).code) : error ? 1 : 0;
        resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
  });
}

async function runScenario(reason: string | undefined, signal?: AbortSignal, extraArgs: string[] = []) {
  const args = [SCENARIO];
  if (APP) args.push('--app', APP);
  if (reason) args.push('--goal-note', reason);
  args.push(...extraArgs);
  // Отчёт каждого вызова — в свой файл: общий отчёт от прошлых запусков уже один раз
  // показал модели чужие улики (чужой пакет и чужое время) как доказательство.
  fs.mkdirSync(REPORTS, { recursive: true });
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`;
  const reportPath = path.join(REPORTS, `verify-${stamp}.json`);
  args.push('--json', reportPath);

  const startedAt = Date.now();
  const result = await execScenario(args, signal);
  const verdict = result.stdout.match(/VERDICT=(\w+)/)?.[1] ?? null;

  let json: Verdict = {};
  try {
    const info = fs.statSync(reportPath);
    // Файл должен быть свежее начала вызова, иначе это отчёт прошлого прогона.
    if (info.mtimeMs >= startedAt) json = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Verdict;
  } catch { /* отчёта нет — сценарий не дошёл */ }

  const evidence = (json.reasons ?? []).map(r => `  ${r}`).join('\n');
  const text = [
    verdict ? `VERDICT=${verdict}` : 'VERDICT=НЕ ЗАВЕРШИЛСЯ',
    evidence,
    !verdict ? `  Проверка не дошла до вердикта (код ${result.code}). Это НЕ значит «всё хорошо» — повтори вызов.` : '',
    result.stderr.trim() ? `stderr: ${result.stderr.trim().slice(0, 400)}` : ''
  ].filter(Boolean).join('\n');

  return { verdict, code: result.code, json, text, reportPath };
}

export default function activate(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'repro',
    label: 'Воспроизвести симптом',
    description: [
      'Прогнать пользовательский сценарий на устройстве и проверить, что баг ВОСПРОИЗВОДИТСЯ.',
      'Запускает приложение, идёт по тому пути, о котором говорит пользователь, и смотрит exit-info и logcat.',
      'CRASH — симптом подтверждён (есть крах с уликой), OK — не воспроизводится, NOT_RUN — сценарий не состоялся либо стенд испорчен (это не успех).',
      'Вызывай это ПЕРЕД правкой: без воспроизведения непонятно, что вообще починили.',
    ].join(' '),
    promptSnippet: 'repro — воспроизвести симптом из жалобы на устройстве (ждёт падения)',
    promptGuidelines: ['Прежде чем править код, воспроизведи симптом инструментом repro.'],
    parameters: Type.Object({
      reason: Type.Optional(Type.String({ description: 'Что воспроизводим (попадёт в лог прогона).' })),
    }),
    async execute(_id, params, signal) {
      const { verdict, text, json, code } = await runScenario(params.reason, signal);
      const ok = verdict === 'CRASH';
      return {
        content: [{ type: 'text' as const, text: ok ? `${text}\n  → Симптом воспроизведён: можно искать причину.` : text }],
        details: { verdict, exitCode: code, evidence: json.evidence ?? null },
        isError: !ok
      };
    },
  });

  pi.registerTool({
    name: 'verify',
    label: 'Проверка на устройстве',
    description: [
      'Прогнать пользовательский сценарий на устройстве и проверить, что баг УШЁЛ.',
      'Вердикты: OK — сценарий прошёл (падали нет), CRASH — всё ещё падает (с уликой),',
      'NOT_RUN — сценарий не состоялся или стенд испорчен, и это НЕ значит «падения нет».',
      'Вызывай это после правки: доказательством считается прогон сценария, а не чтение кода.',
    ].join(' '),
    promptSnippet: 'verify — прогнать пользовательский сценарий на устройстве и получить вердикт',
    promptGuidelines: [
      'После правки вызывай verify, а не рассуждай о том, «должно работать».',
      'Вердикт NOT_RUN не является успехом — разберись, почему сценарий не состоялся.',
    ],
    parameters: Type.Object({
      reason: Type.Optional(Type.String({ description: 'Что проверяем (попадёт в лог прогона).' })),
    }),
    async execute(_id, params, signal) {
      const { verdict, text, json, code } = await runScenario(params.reason, signal);
      return {
        content: [{ type: 'text' as const, text }],
        details: { verdict, exitCode: code, evidence: json.evidence ?? null },
        isError: verdict !== 'OK'
      };
    },
  });
}
