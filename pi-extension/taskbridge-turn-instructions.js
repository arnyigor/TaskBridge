// Production-расширение (CORE-02): инструкции хода вместо дописывания блока в
// текст пользовательского сообщения.
//
// Ровно четыре действия (как и требует задание):
//   1. определить профиль текущего пользовательского запроса;
//   2. получить текст инструкции из общего генератора (`src/prompt-builder.mjs`);
//   3. присвоить структурированную секцию `turn_instructions`;
//   4. завершить обработку.
//
// Никаких проверок инструментов, счётчиков и остановок здесь нет.
//
// Две особенности Pi 1.3.0, найденные в PoC (docs/pi-hooks-feasibility.md):
//   • `systemPromptOptions` — ОБЩИЙ базовый объект, который Pi передаёт в хук на
//     каждом ходу: дописывание (`sections.x += …`) накапливается между ходами.
//     Поэтому секция только присваивается.
//   • ходы, начатые не оператором (`messageType: 'custom'` — regenerate,
//     продолжение после 413), инструкций не получают: иначе «продолжение ответа»
//     сменило бы профиль на середине.
//
// Расширение подключается через `-e` (см. src/task-manager.mjs, режим `hook`).
import { detectProfile, turnInstructions } from '../src/prompt-builder.mjs';

export const INSTRUCTIONS_SECTION = 'turn_instructions';

export default function turnInstructionsExtension(pi) {
  pi.on('before_agent_start', async (event) => {
    if (event.messageType !== 'user') return;
    const profile = detectProfile(String(event.prompt || ''));
    // Присваивание, а не дописывание: одна и та же секция на каждом ходу.
    event.systemPromptOptions.sections = {
      ...event.systemPromptOptions.sections,
      [INSTRUCTIONS_SECTION]: turnInstructions(profile),
    };
  });
}
