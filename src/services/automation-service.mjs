// Домен автоматизаций: Run Recipes (MR-05), Schedules и Invocations (MR-06).
//
// Вынесен из TaskManager, чтобы правки планировщика и рецептов не касались файла,
// в котором живут чат, STOP и очередь сообщений. Сервис принимает ТОЛЬКО узкие
// колбэки (они перечислены в конструкторе), а не весь TaskManager: у него нет
// доступа к `_turn`, `_compacting`, `runtimes` и прочим полям хода, поэтому он
// физически не может сломать ядро чата. Тестируется отдельно, как обычный класс.
//
// Инвариант, который здесь держится: инвокация и сессия — одно и то же событие,
// а не две таблицы об одном факте. Пропущенный по политике запуск тоже
// записывается: «не запускалось» — это информация.

import crypto from 'node:crypto';
import { validateRecipe, renderRecipe } from '../recipes/recipe.mjs';
import { normalizeSchedule, nextRunAfter, resolveMisfire } from '../scheduler/schedule.mjs';
import { invocationSummary as buildInvocationSummary } from '../automation/invocation-summary.mjs';

const DEFAULT_STALE_VERIFICATION_MS = 10 * 60_000;
const DEFAULT_ORPHAN_INVOCATION_MS = 5 * 60_000;

const now = () => new Date().toISOString();
const shortId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 12);

/** `provider/id` из строки рецепта; без слэша — только id. */
function parseModelSelection(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const slash = text.indexOf('/');
  if (slash <= 0) return { provider: null, id: text };
  return { provider: text.slice(0, slash), id: text.slice(slash + 1) };
}

export class AutomationService {
  #tickInFlight = false;

  /**
   * Явные зависимости вместо ссылки на весь TaskManager:
   * - store: TaskStore
   * - config: корневой config.json (verificationProfiles, schedules.orphanMs, verification.staleAfterMs)
   * - hasProject(projectId): boolean
   * - getTaskRaw(taskId): внутренний объект задачи или undefined
   * - publicTask(task): публичный снимок задачи
   * - createTask(input, opts): Promise<Task>
   * - cancelTask(taskId, opts): Promise<Task>
   * - recordEvent(task, type, message, data): Promise<Event>
   * - linkWorkItemSession(workItemId, sessionId, relation): void
   */
  constructor({
    store,
    config = {},
    hasProject,
    getTaskRaw,
    publicTask,
    createTask,
    cancelTask,
    recordEvent,
    linkWorkItemSession,
  }) {
    this.store = store;
    this.config = config;
    this.hasProject = hasProject;
    this.getTaskRaw = getTaskRaw;
    this.publicTask = publicTask;
    this.createTask = createTask;
    this.cancelTask = cancelTask;
    this.recordEvent = recordEvent;
    this.linkWorkItemSession = linkWorkItemSession;
  }

  // --- Recipes (MR-05) -----------------------------------------------------

  listRecipes({ projectId = null } = {}) {
    return this.store.listRecipes(projectId);
  }

  getRecipe(id) {
    const recipe = this.store.getRecipe(id);
    if (!recipe) throw Object.assign(new Error('Рецепт не найден.'), { code: 'NOT_FOUND' });
    return recipe;
  }

  createRecipe(input = {}) {
    const validated = validateRecipe(input);
    if (!validated.projectId) throw Object.assign(new Error('Укажите проект.'), { code: 'INPUT_INVALID' });
    if (!this.hasProject(validated.projectId)) {
      throw Object.assign(new Error('Проект не найден.'), { code: 'PROJECT_NOT_FOUND' });
    }
    // Рецепт, называющий рабочую задачу, обязан называть существующую: запуск
    // должен быть прикрепляем к тому, что оператор может открыть.
    if (validated.workItemId && !this.store.getWorkItem(validated.workItemId)) {
      throw Object.assign(new Error('Задача не найдена.'), { code: 'NOT_FOUND' });
    }
    const at = now();
    return this.store.createRecipe({ id: `rc-${shortId()}`, ...validated, createdAt: at, updatedAt: at });
  }

  updateRecipe(id, patch = {}) {
    const current = this.getRecipe(id);
    const validated = validateRecipe({
      ...current,
      ...patch,
      parameters: patch.parameters === undefined ? current.parameters : patch.parameters,
      runtime: { ...current.runtime, ...(patch.runtime ?? {}) },
      context: { ...current.context, ...(patch.context ?? {}) },
      workspace: { ...current.workspace, ...(patch.workspace ?? {}) },
      verification: { ...current.verification, ...(patch.verification ?? {}) },
      limits: { ...current.limits, ...(patch.limits ?? {}) },
    });
    if (!this.hasProject(validated.projectId)) {
      throw Object.assign(new Error('Проект не найден.'), { code: 'PROJECT_NOT_FOUND' });
    }
    if (validated.workItemId && !this.store.getWorkItem(validated.workItemId)) {
      throw Object.assign(new Error('Задача не найдена.'), { code: 'NOT_FOUND' });
    }
    return this.store.updateRecipe(id, { ...validated, updatedAt: now() });
  }

  deleteRecipe(id) {
    const removed = this.store.deleteRecipe(id);
    if (!removed) throw Object.assign(new Error('Рецепт не найден.'), { code: 'NOT_FOUND' });
    return removed;
  }

  /**
   * Рецепт в том виде, в каком он пойдёт сейчас: параметры разрешены,
   * подставляемые поля отрендерены. Предпросмотр и запуск используют ОДНУ функцию,
   * поэтому телефон не может показать одно, а машина выполнить другое.
   */
  previewRecipe(id, { parameters = {} } = {}) {
    return renderRecipe(this.getRecipe(id), parameters);
  }

  /**
   * Запуск рецепта: создаёт сессию из отрендеренного промпта. Инвокация И ЕСТЬ эта
   * сессия — отдельная таблица `scheduled_runs` была бы вторым источником правды.
   */
  async runRecipe(id, { parameters = {}, clientId = null, deviceId = null, trigger = 'manual', invocationId = null } = {}) {
    const recipe = this.getRecipe(id);
    const rendered = renderRecipe(recipe, parameters);
    if (recipe.workItemId && !this.store.getWorkItem(recipe.workItemId)) {
      throw Object.assign(new Error('Задача рецепта не найдена.'), { code: 'NOT_FOUND' });
    }
    const model = rendered.runtime?.model ? parseModelSelection(rendered.runtime.model) : null;
    const task = await this.createTask({
      projectId: rendered.projectId,
      prompt: rendered.prompt,
      title: `${rendered.name}`,
      model,
      thinkingLevel: rendered.runtime?.thinking ?? null,
    }, { clientId, deviceId });
    const stored = this.getTaskRaw(task.id);
    if (stored) {
      // Какой рецепт породил сессию и с какими параметрами: единственный durable
      // след запуска, и то, что читает «повторить с параметрами».
      stored.recipeRun = {
        recipeId: recipe.id,
        recipeName: recipe.name,
        trigger,
        invocationId,
        parameters: rendered.parameters,
        at: now(),
      };
      // Профиль проверки — ИМЯ, которым владеет проект, поэтому промпт никогда не
      // несёт shell-команды (ROADMAP_FULL.md, «Verification profiles»).
      const profile = rendered.verification?.command ? String(rendered.verification.command) : null;
      if (profile && this.config.verificationProfiles?.[profile]) {
        stored.verificationCommands = [...this.config.verificationProfiles[profile]];
      } else if (profile) {
        stored.verificationCommands = [profile];
      }
      stored.updatedAt = now();
      await this.store.save(this.publicTask(stored)).catch(() => {});
      try {
        await this.recordEvent(stored, 'RECIPE_RUN', `Запуск рецепта «${recipe.name}»`, {
          recipeId: recipe.id,
          trigger,
          parameters: rendered.parameters,
        });
      } catch { /* сессия уже создана — это главное */ }
    }
    // Рецепт, привязанный к рабочей задаче, делает свой запуск её частью.
    if (recipe.workItemId) {
      try {
        this.linkWorkItemSession(recipe.workItemId, task.id, 'implementation');
      } catch { /* см. выше */ }
    }
    return { task: stored ? this.publicTask(stored) : task, invocation: stored?.recipeRun ?? null, rendered };
  }

  // --- Schedules & Invocations (MR-06) -------------------------------------
  //
  // Планировщик живёт на ПК, не на телефоне и не в релее: выключенный телефон
  // ничего не меняет в том, случится ли 09:00. Каждый тик — одно решение на
  // просроченное расписание, и каждое решение записывается инвокацией, включая
  // пропущенные: «не запускалось» — тоже информация.

  listSchedules({ recipeId = null } = {}) {
    return this.store.listSchedules(recipeId);
  }

  getSchedule(id) {
    const schedule = this.store.getSchedule(id);
    if (!schedule) throw Object.assign(new Error('Расписание не найдено.'), { code: 'NOT_FOUND' });
    return schedule;
  }

  createSchedule(input = {}) {
    const recipeId = String(input.recipeId ?? '').trim();
    if (!recipeId) throw Object.assign(new Error('Укажите рецепт.'), { code: 'INPUT_INVALID' });
    const recipe = this.getRecipe(recipeId);
    const normalized = normalizeSchedule(input, { recipe });
    const at = now();
    // Первый момент считается из спеки, а не из клиента: два клиента, посчитавшие
    // «09:00» по-разному, — это запуск дважды.
    const anchor = normalized.spec.kind === 'interval' ? at : null;
    return this.store.createSchedule({
      id: `sc-${shortId()}`,
      ...normalized,
      nextRunAt: nextRunAfter(normalized.spec, at, { anchor }),
      lastRunAt: null,
      createdAt: at,
      updatedAt: at,
    });
  }

  updateSchedule(id, patch = {}) {
    const current = this.getSchedule(id);
    const merged = normalizeSchedule({
      ...current,
      ...patch,
      spec: patch.spec === undefined ? current.spec : patch.spec,
      parameters: patch.parameters === undefined ? current.parameters : patch.parameters,
    }, { recipe: this.getRecipe(current.recipeId) });
    // Изменённое расписание пересчитывает следующий момент; пауза его сохраняет,
    // чтобы возобновление не перескочило молча на завтра.
    const specChanged = JSON.stringify(merged.spec) !== JSON.stringify(current.spec);
    const resumed = merged.enabled && !current.enabled;
    const at = now();
    // Один якорь на всю жизнь расписания: интервал обязан оставаться на СВОЕЙ сетке,
    // иначе `nextRunAt` перестаёт быть одним из его вхождений и тик видит должный
    // момент, которому не соответствует ни одно вхождение (пропуск исчезает молча).
    const nextRunAt = (specChanged || resumed)
      ? nextRunAfter(merged.spec, at, { anchor: merged.spec.kind === 'interval' ? current.createdAt : null })
      : current.nextRunAt;
    return this.store.updateSchedule(id, { ...merged, nextRunAt, updatedAt: at });
  }

  deleteSchedule(id) {
    const removed = this.store.deleteSchedule(id);
    if (!removed) throw Object.assign(new Error('Расписание не найдено.'), { code: 'NOT_FOUND' });
    return removed;
  }

  /** «Запустить сейчас»: тот же путь, что у расписания, только повод — оператор. */
  async runScheduleNow(id, { clientId = null, deviceId = null } = {}) {
    const schedule = this.getSchedule(id);
    const recipe = this.getRecipe(schedule.recipeId);
    const invocation = await this.#invoke(recipe, {
      schedule,
      scheduledAt: now(),
      trigger: 'manual',
      misfire: false,
      parameters: schedule.parameters,
      clientId,
      deviceId,
    });
    // Запуск руками не двигает собственные часы расписания.
    await this.store.updateSchedule(id, { ...schedule, lastRunAt: invocation.startedAt, updatedAt: now() });
    return invocation;
  }

  listInvocations(options = {}) {
    return this.store.listInvocations(options);
  }

  getInvocation(id) {
    const invocation = this.store.getInvocation(id);
    if (!invocation) throw Object.assign(new Error('Запуск не найден.'), { code: 'NOT_FOUND' });
    return invocation;
  }

  /** Компактная сводка запуска (AUTO-03B): читает инвокацию и её сессию, ничего не пишет. */
  invocationSummary(id) {
    const invocation = this.getInvocation(id);
    const session = invocation?.sessionId ? this.getTaskRaw(invocation.sessionId) ?? null : null;
    return buildInvocationSummary(invocation, session);
  }

  /**
   * Один тик планировщика. [opts.dryRun] отвечает, что БЫ случилось, ничего не
   * создавая — тот же код решений, чтобы тест мог спросить, а не ждать.
   */
  async schedulerTick({ nowIso = now(), dryRun = false } = {}) {
    // Два тика не должны работать над одним и тем же моментом: расписание
    // сдвигается только в конце своей обработки, поэтому наложившийся тик увидел
    // бы его снова и создал вторую сессию (QUEUE и PARALLEL сами не дедуплицируют).
    // Пробный тик (`dryRun`) ничего не создаёт и блокировку не берёт.
    if (!dryRun && this.#tickInFlight) {
      return { at: nowIso, decisions: [], reconciled: [], skipped: 'busy' };
    }
    if (!dryRun) this.#tickInFlight = true;
    try {
      return await this.#schedulerTickLocked({ nowIso, dryRun });
    } finally {
      if (!dryRun) this.#tickInFlight = false;
    }
  }

  async #schedulerTickLocked({ nowIso, dryRun }) {
    const decisions = [];
    for (const schedule of this.store.dueSchedules(nowIso)) {
      const recipe = this.store.getRecipe(schedule.recipeId);
      if (!recipe) {
        decisions.push({ scheduleId: schedule.id, action: 'recipe-gone' });
        if (!dryRun) {
          await this.store.updateSchedule(schedule.id, {
            ...schedule,
            enabled: false,
            nextRunAt: null,
            updatedAt: nowIso,
          });
        }
        continue;
      }
      const misfire = resolveMisfire(schedule, nowIso, {
        anchor: schedule.spec?.kind === 'interval' ? schedule.createdAt : null,
      });
      // `lastRunAt` двигается вместе с запусками этого тика, поэтому хранится здесь,
      // а не читается из объекта расписания, снятого до цикла: он устаревает ко
      // второй записи и стёр бы отметку.
      let lastRunAt = schedule.lastRunAt;
      const advance = async () => {
        if (dryRun) return;
        await this.store.updateSchedule(schedule.id, { ...schedule, nextRunAt: misfire.nextRunAt, lastRunAt, updatedAt: nowIso });
      };

      if (!misfire.runs.length) {
        // SKIP (или ничего не пропущено): момент израсходован и записан, чтобы
        // оператор увидел «пропущено», а не молчаливую дыру.
        decisions.push({ scheduleId: schedule.id, action: 'skipped', missed: misfire.missed, reason: misfire.policy });
        if (!dryRun && misfire.missed > 0) {
          await this.store.createInvocation({
            id: `inv-${shortId()}`,
            recipeId: recipe.id,
            scheduleId: schedule.id,
            trigger: 'schedule',
            scheduledAt: schedule.nextRunAt,
            startedAt: nowIso,
            finishedAt: nowIso,
            status: 'SKIPPED',
            reason: `пропущено по политике ${misfire.policy}`,
            misfire: true,
            parameters: schedule.parameters,
          });
        }
        await advance();
        continue;
      }

      for (const moment of misfire.runs) {
        const running = this.store.runningInvocations(schedule.id);
        if (running.length && schedule.concurrencyPolicy === 'SKIP_IF_RUNNING') {
          decisions.push({ scheduleId: schedule.id, action: 'busy', reason: schedule.concurrencyPolicy });
          if (!dryRun) {
            await this.store.createInvocation({
              id: `inv-${shortId()}`,
              recipeId: recipe.id,
              scheduleId: schedule.id,
              trigger: 'schedule',
              scheduledAt: moment,
              startedAt: nowIso,
              finishedAt: nowIso,
              status: 'SKIPPED',
              reason: 'предыдущий запуск ещё идёт (SKIP_IF_RUNNING)',
              misfire: moment !== schedule.nextRunAt,
              parameters: schedule.parameters,
            });
          }
          continue;
        }
        if (running.length && schedule.concurrencyPolicy === 'REPLACE') {
          decisions.push({ scheduleId: schedule.id, action: 'replace', replaced: running.map(item => item.id) });
          if (!dryRun) {
            for (const previous of running) {
              if (previous.sessionId && this.getTaskRaw(previous.sessionId)) {
                await this.cancelTask(previous.sessionId, {}).catch(() => {});
              }
              await this.store.updateInvocation(previous.id, {
                status: 'FAILED',
                reason: 'заменён новым запуском (REPLACE)',
                finishedAt: nowIso,
              });
            }
          }
        }
        // QUEUE и PARALLEL оба создают сессию: собственная очередь TaskBridge
        // сериализует то, что машина не может выполнить сразу, а PARALLEL безопасен
        // только с независимыми worktree (это решает стратегия рабочей папки).
        if (dryRun) {
          decisions.push({ scheduleId: schedule.id, action: 'run', scheduledAt: moment, policy: schedule.concurrencyPolicy });
          continue;
        }
        const invocation = await this.#invoke(recipe, {
          schedule,
          scheduledAt: moment,
          trigger: 'schedule',
          misfire: moment !== schedule.nextRunAt || misfire.missed > 0,
          parameters: schedule.parameters,
        });
        decisions.push({ scheduleId: schedule.id, action: 'run', invocationId: invocation.id, sessionId: invocation.sessionId, scheduledAt: moment });
        lastRunAt = invocation.startedAt;
      }
      await advance();
    }
    // Сессии, завершившиеся, пока инвокация ещё числилась RUNNING: инвокация идёт
    // за своей сессией, в том числе после перезапуска сервера.
    const reconciled = dryRun ? [] : await this.#reconcileInvocations(nowIso);
    return { at: nowIso, decisions, reconciled };
  }

  /** Создаёт инвокацию и сессию, которую она описывает. */
  async #invoke(recipe, { schedule = null, scheduledAt = null, trigger = 'manual', misfire = false, parameters = {}, clientId = null, deviceId = null } = {}) {
    const at = now();
    const draft = {
      id: `inv-${shortId()}`,
      recipeId: recipe.id,
      scheduleId: schedule?.id ?? null,
      trigger,
      scheduledAt,
      startedAt: at,
      finishedAt: null,
      status: 'RUNNING',
      reason: null,
      misfire: misfire === true,
      parameters,
      sessionId: null,
      verification: null,
      workspaceRef: null,
      resultArtifact: null,
    };
    await this.store.createInvocation(draft);
    try {
      const started = await this.runRecipe(recipe.id, { parameters, clientId, deviceId, trigger, invocationId: draft.id });
      const session = started.task;
      await this.store.updateInvocation(draft.id, { sessionId: session.id });
      const stored = this.getTaskRaw(session.id);
      // Политика уведомлений РАСПИСАНИЯ решает, стоит ли кого-то будить: сессия
      // несёт ответ в push-путь, и он сохраняется, чтобы перезапуск не потерял
      // политику посреди прогона.
      if (stored && schedule) {
        stored.scheduleNotify = schedule.notify;
        await this.store.save(this.publicTask(stored)).catch(() => {});
      }
      return this.store.getInvocation(draft.id);
    } catch (failure) {
      // Рецепт, который не может стартовать (неизвестный проект, плохие параметры),
      // — это завершённая инвокация с причиной, а не пропавшая.
      return this.store.updateInvocation(draft.id, {
        status: 'FAILED',
        reason: String(failure?.message ?? failure).slice(0, 500),
        finishedAt: now(),
      });
    }
  }

  /**
   * Копирует исход завершённых сессий в их инвокации: статус, результат проверки и
   * артефакт, который человек откроет. «Проверка обязательна» превращает сессию,
   * которая отработала но не прошла, в проваленный запуск — иначе «запустилось»
   * читалось бы как «получилось».
   */
  async #reconcileInvocations(nowIso = now()) {
    const finished = [];
    for (const invocation of this.store.runningInvocations()) {
      const session = invocation.sessionId ? this.getTaskRaw(invocation.sessionId) : null;
      if (!session) {
        if (invocation.sessionId) {
          // Сессия исчезла (удалена руками, стёрт каталог данных): сказать об этом,
          // а не оставлять запуск «в процессе» навсегда.
          await this.store.updateInvocation(invocation.id, {
            status: 'FAILED',
            reason: 'сессия запуска больше не существует',
            finishedAt: nowIso,
          });
          finished.push(invocation.id);
          continue;
        }
        // Падение между созданием инвокации и стартом сессии: исход неизвестен.
        // Молодую запись не трогаем — `#invoke` вот-вот проставит `sessionId`;
        // старую закрываем как неизвестную и НЕ переисполняем автоматически.
        const startedAt = Date.parse(invocation.startedAt ?? '');
        const age = Number.isFinite(startedAt) ? Date.now() - startedAt : Number.POSITIVE_INFINITY;
        if (age < this.#orphanInvocationMs()) continue;
        await this.store.updateInvocation(invocation.id, {
          status: 'FAILED',
          reason: 'сессия не была создана: исход запуска неизвестен, повтор не выполнялся',
          finishedAt: nowIso,
        });
        finished.push(invocation.id);
        continue;
      }
      if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(session.status)) continue;
      const recipe = this.store.getRecipe(invocation.recipeId);
      const verification = session.verificationStatus ?? null;
      const requiresVerification = recipe?.verification?.required === true;
      // Проверка запускается ОТДЕЛЬНО после публикации `SUCCEEDED`: между этими
      // моментами `verificationStatus === 'RUNNING'`, и считать это провалом значило
      // бы записывать `FAILED` успешному прогону, у которого тесты ещё идут. Ждём
      // следующего тика; зависшая проверка не может держать запуск вечно — её
      // закрывает срок ниже.
      if (requiresVerification && verification === 'RUNNING') {
        // Возраст считается по реальным часам, а не по `nowIso` тика: в тестах
        // «сейчас» намеренно уезжает вперёд, и проверка, идущая секунду, выглядела
        // бы зависшей.
        const staleAfterMs = this.#staleVerificationMs();
        const since = Date.parse(session.updatedAt ?? '');
        const waited = Number.isFinite(since) ? Date.now() - since : staleAfterMs;
        if (!Number.isFinite(waited) || waited < staleAfterMs) continue;
        await this.store.updateInvocation(invocation.id, {
          status: 'FAILED',
          reason: `проверка не завершилась за ${Math.round(staleAfterMs / 60_000) || 1} мин: итог неизвестен`,
          verification,
          finishedAt: nowIso,
          workspaceRef: session.workspacePath ?? invocation.workspaceRef,
          resultArtifact: null,
        });
        finished.push(invocation.id);
        continue;
      }
      // Остановка оператором — это остановка, а не провал проверки: иначе STOP
      // читался бы в истории как «тесты не прошли» (AUTO-03A).
      const cancelled = session.status === 'CANCELLED';
      const failedVerification = !cancelled && requiresVerification && verification !== 'PASSED';
      const status = cancelled ? 'CANCELLED' : (failedVerification ? 'FAILED' : session.status);
      const reason = cancelled
        ? (session.error ? String(session.error).slice(0, 300) : 'остановлено оператором')
        : failedVerification
          ? `проверка не пройдена (${verification ?? 'не запускалась'}), хотя рецепт её требует`
          : (session.error ? String(session.error).slice(0, 300) : null);
      await this.store.updateInvocation(invocation.id, {
        status,
        reason,
        verification,
        finishedAt: session.updatedAt ?? nowIso,
        // Где шла работа, известно только после реального запуска сессии.
        workspaceRef: session.workspacePath ?? invocation.workspaceRef,
        resultArtifact: session.status === 'SUCCEEDED' ? 'result.md' : null,
      });
      finished.push(invocation.id);
    }
    return finished;
  }

  /** Через сколько «инвокация без сессии» считается брошенной, а не начинающейся. */
  #orphanInvocationMs() {
    const configured = Number(this.config.schedules?.orphanMs);
    if (Number.isFinite(configured) && configured >= 0) return configured;
    return DEFAULT_ORPHAN_INVOCATION_MS;
  }

  /** Срок, после которого зависшая проверка считается неизвестным исходом. */
  #staleVerificationMs() {
    const configured = Number(this.config.verification?.staleAfterMs);
    if (Number.isFinite(configured) && configured >= 0) return configured;
    return DEFAULT_STALE_VERIFICATION_MS;
  }
}
