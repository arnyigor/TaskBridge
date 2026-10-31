// Fixture for experiments/thinking-level: a realistic Android/KMP task on a copy of
// the real client module — one bug, one feature, one refactor, verified by the
// project's own Gradle tests.
//
// The bug is planted in `SessionGroup`-filtering (scratch sessions disappear when a
// project filter is set) and the feature is «search also matches the project folder
// name and the session id». Both are covered by a test file this fixture writes and
// hashes: a run that deletes or edits the tests is not a pass.
import fs from 'node:fs/promises';
import path from 'node:path';

export const TEST_RELATIVE = 'core/client/src/jvmTest/kotlin/ru/arny/taskbridge/core/client/SessionQueryAcceptanceTest.kt';

const TEST_SOURCE = `package ru.arny.taskbridge.core.client

import ru.arny.taskbridge.core.api.SCRATCH_PROJECT_ID
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.client.sessions.SessionListState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Приёмочные проверки списка сессий (задание оператора: баг + функционал).
 *
 * Этот файл менять нельзя: он описывает ожидаемое поведение, а не реализацию.
 */
class SessionQueryAcceptanceTest {
    private fun state(): SessionListState = SessionListState(
        loading = false,
        tasks = listOf(
            Task(id = "s1", title = "Сборка релиза", projectId = "p1", updatedAt = "2026-10-30T10:00:00Z", status = "SUCCEEDED"),
            Task(id = "s2", title = "Починить краш", projectId = null, updatedAt = "2026-10-30T11:00:00Z", status = "RUNNING"),
            Task(id = "s3", title = "Экран настроек", projectId = "p2", updatedAt = "2026-10-30T09:00:00Z", status = "SUCCEEDED"),
        ),
        projects = emptyList(),
    )

    /** Баг: при фильтре по «Без проекта» сессии без проекта терялись. */
    @Test
    fun \`scratch sessions survive the project filter\`() {
        val groups = state().groups(projectId = SCRATCH_PROJECT_ID)
        assertEquals(1, groups.size)
        assertEquals(listOf("s2"), groups.single().sessions.map { it.id })
    }

    /** Баг-следствие: без фильтра сессии без проекта попадают в свою группу. */
    @Test
    fun \`without a filter every session is present\`() {
        val ids = state().groups().flatMap { group -> group.sessions.map { it.id } }.sorted()
        assertEquals(listOf("s1", "s2", "s3"), ids)
    }

    /** Функционал: поиск ищет и по id сессии, а не только по заголовку и промпту. */
    @Test
    fun \`search finds a session by id\`() {
        val groups = state().groups(query = "s3")
        assertEquals(listOf("s3"), groups.flatMap { group -> group.sessions.map { it.id } })
    }

    /** Функционал: поиск устойчив к регистру и пробелам вокруг запроса. */
    @Test
    fun \`search is case and whitespace tolerant\`() {
        val groups = state().groups(query = "  ПОЧИНИТЬ  ")
        assertEquals(listOf("s2"), groups.flatMap { group -> group.sessions.map { it.id } })
    }

    /** Регрессия: группировка по проекту не разваливается при сортировке. */
    @Test
    fun \`groups keep their project id\`() {
        val groups = state().groups()
        assertTrue(groups.any { it.projectId == "p1" })
        assertTrue(groups.any { it.projectId == "p2" })
        assertTrue(groups.any { it.projectId == SCRATCH_PROJECT_ID })
    }
}
`;

const TASK_MARKDOWN = `# Задание

Модуль \`core/client\` — клиентская логика Android/KMP приложения TaskBridge (список сессий).
В нём есть баг и незаконченный функционал. Работай как обычно: сначала разберись, потом правь.

## Что нужно

1. **Баг.** При фильтре по проекту «Без проекта» (\`SCRATCH_PROJECT_ID\`) сессии без проекта
   пропадают из списка. Найди причину в \`core/client/src/commonMain/kotlin/ru/arny/taskbridge/core/client/sessions/SessionList.kt\`
   (функция \`groups\`) и исправь.
2. **Функционал.** Поиск (query) должен находить сессию также по её id. Сейчас ищет только по
   заголовку и промпту. Регистр и пробелы вокруг запроса уже нормализуются — не ломай это.
3. **Рефакторинг.** Вынеси фильтрацию и поиск из \`groups\` в отдельную небольшую сущность
   (например объект \`SessionQuery\` с чистой функцией) так, чтобы \`groups\` осталась читаемой
   и поведение не изменилось. Публичный API \`groups(query, projectId)\` трогать нельзя.

## Проверка

Приёмочные тесты лежат в
\`${'core/client/src/jvmTest/kotlin/ru/arny/taskbridge/core/client/SessionQueryAcceptanceTest.kt'}\` —
**этот файл менять нельзя**, он описывает ожидаемое поведение.

Запуск тестов (из этой папки):

\`\`\`
./gradlew -p core :client:jvmTest --no-configuration-cache --console=plain
\`\`\`

Флаг \`--no-configuration-cache\` обязателен: без него Gradle может переиспользовать
конфигурацию основного репозитория и «не увидеть» правки.

## Готово, когда

- все тесты в \`:client:jvmTest\` зелёные (и старые, и приёмочные);
- приёмочный файл не изменён;
- в конце ответа — короткий отчёт: что было причиной бага, что изменил, где рефакторинг.
`;

/**
 * Copy the real module into a sandbox and plant the task.
 *
 * The sandbox mirrors the repository layout (`clients/kmp/core` + `tests/fixtures`),
 * because several existing tests read fixtures through
 * `rootProject.projectDir.resolve("../../../tests/fixtures/...")`. Without that the
 * baseline is red for reasons unrelated to the task, and the verdict means nothing.
 *
 * Returns `{ work, taskPath, testPath, testSource, buggy }` with `work` = the
 * directory the agent works in.
 */
export async function prepareFixture(outDir) {
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
  const kmp = path.join(repo, 'clients', 'kmp');
  const work = path.join(outDir, 'repo', 'clients', 'kmp');
  await fs.mkdir(work, { recursive: true });
  await fs.cp(path.join(kmp, 'core'), path.join(work, 'core'), {
    recursive: true,
    filter: source => !source.split(path.sep).includes('build'),
  });
  await fs.cp(path.join(kmp, 'gradle'), path.join(work, 'gradle'), { recursive: true });
  await fs.cp(path.join(repo, 'tests', 'fixtures'), path.join(outDir, 'repo', 'tests', 'fixtures'), { recursive: true });
  for (const file of ['gradlew', 'gradlew.bat']) {
    await fs.copyFile(path.join(kmp, file), path.join(work, file));
  }

  // The planted bug: the scratch project is filtered out because the raw projectId
  // is compared instead of the normalised one.
  const sessionList = path.join(work, 'core/client/src/commonMain/kotlin/ru/arny/taskbridge/core/client/sessions/SessionList.kt');
  const original = await fs.readFile(sessionList, 'utf8');
  const fixed = '            .filter { projectId == null || (it.projectId ?: SCRATCH_PROJECT_ID) == projectId }';
  const buggy = '            .filter { projectId == null || it.projectId == projectId }';
  if (!original.includes(fixed)) throw new Error('fixture: the filter line changed upstream; update the fixture');
  await fs.writeFile(sessionList, original.replace(fixed, buggy), 'utf8');

  const testPath = path.join(work, TEST_RELATIVE);
  await fs.mkdir(path.dirname(testPath), { recursive: true });
  await fs.writeFile(testPath, TEST_SOURCE, 'utf8');
  await fs.writeFile(path.join(work, 'TASK.md'), TASK_MARKDOWN, 'utf8');
  return { work, taskPath: path.join(work, 'TASK.md'), testPath, testSource: TEST_SOURCE, buggy };
}
