// PoC (TASKBRIDGE-CORE-01): инструкции хода через штатный Pi-хук
// `before_agent_start`, а не через текст пользовательского сообщения.
//
// Что проверяется этим файлом:
//   • хук получает `prompt` — сырой текст оператора (после развёртывания
//     /skill: и /template, но ДО добавления каких-либо инструкций), поэтому
//     сообщение в журнале остаётся дословным;
//   • `event.systemPromptOptions` — изменяемая структура секций этого хода;
//     мы ПЕРЕЗАПИСЫВАЕМ одну именованную секцию `turn_instructions`, а не
//     дописываем, поэтому между ходами ничего не накапливается;
//   • Pi сравнивает получившиеся секции с тем, что модель уже имеет в
//     транскрипте (`diffSystemPromptSections`) и отправляет только дельту;
//   • ошибка в хуке не ломает ход: Pi ловит её, пишет в stderr и продолжает.
//
// Эксперимент намеренно не импортирует TaskBridge иначе как для классификатора:
// путь доставки сообщений, PromptBuilder и сервер не участвуют.
import fs from 'node:fs';
import { detectProfile } from '../../src/prompt-builder.mjs';

// Тот же контракт, что у PromptBuilder. В реальной интеграции это одна
// экспортируемая функция из src/prompt-builder.mjs — копия здесь, чтобы PoC
// можно было удалить целиком, ничего не меняя в рабочем коде.
const CONTRACT = [
  'Do only what the request asks: the request defines the goal, these notes only set the boundaries.',
  'Before each additional step, check which open question of the request it answers; once the requested answer is confirmed, report it and stop.',
  'If the answer is not confirmed, say which part is unconfirmed instead of guessing.',
  'If a tool fails, keep what the earlier tools already confirmed and report the failure.',
];

const PROFILE_NOTES = {
  quick: 'This is a lookup: use the fewest commands and stop at the first confirmed answer. Do not modify files unless the request asks for changes.',
  explore: 'Investigation is allowed while an open question of the request remains; do not modify files unless the request asks for changes.',
  implement: 'Make the change the request asks for, verify it, and summarize what changed and which checks ran. Link deliverable files as Markdown relative paths, e.g. [Download report](report.pdf).',
};

const SECTION = 'turn_instructions';

export function instructionsFor(profile) {
  const note = PROFILE_NOTES[profile] || PROFILE_NOTES.explore;
  return `Task instructions (${profile}):\n${[...CONTRACT, note].map(line => `- ${line}`).join('\n')}`;
}

export default function turnInstructions(pi) {
  const logFile = process.env.TB_HOOK_LOG || '';
  const log = entry => {
    if (!logFile) return;
    try { fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`); } catch { /* PoC: журнал не должен ломать ход */ }
  };

  pi.on('before_agent_start', async (event) => {
    // Ход, начатый `pi.sendMessage(..., { triggerTurn: true })`, — не реплика
    // оператора: у него нет prompt, и профиль к нему применять нечего.
    if (event.messageType !== 'user') {
      log({ at: new Date().toISOString(), skipped: 'custom-message' });
      return;
    }
    const text = String(event.prompt || '');
    const profile = detectProfile(text);
    const before = event.systemPrompt.length;
    // Перезапись, а не дополнение: одна и та же секция на каждом ходу.
    event.systemPromptOptions.sections = {
      ...event.systemPromptOptions.sections,
      [SECTION]: instructionsFor(profile),
    };
    const after = event.systemPrompt.length;
    log({
      at: new Date().toISOString(),
      messageType: event.messageType,
      profile,
      // Дословный текст оператора — доказательство, что хук его не менял.
      prompt: text,
      promptChars: text.length,
      systemPromptCharsBefore: before,
      systemPromptCharsAfter: after,
      sections: Object.keys(event.systemPromptOptions.sections),
      selectedTools: event.systemPromptOptions.selectedTools?.length ?? null,
    });
  });

  // Команда нужна, чтобы проверить: команда Pi исполняется штатно (`handled`),
  // хук для неё не срабатывает, и текст пользователя не превращается в промпт.
  pi.registerCommand('tb-profile', {
    description: 'PoC: показать профиль, который выбрал бы хук',
    handler: async (_args, ctx) => {
      ctx.ui.notify('tb-profile: команда исполнена', 'info');
      log({ at: new Date().toISOString(), command: 'tb-profile' });
    },
  });
}
