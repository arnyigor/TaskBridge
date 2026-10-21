// Итоговые уведомления автоматизаций (AUTO-03C, приёмка AUTO-03E).
//
// Вынесено из server.mjs, чтобы «сколько раз отправили» можно было проверить тестом:
// ключ `invocation:<id>` группирует уведомления на устройстве, но сам по себе не
// доказывает, что сервер не отправил два. Здесь — единственное место, где решается,
// что отправлять и сколько раз.
import { notificationForInvocation } from '../push/push-center.mjs';

/**
 * Возвращает функцию «уведомить о завершённых запусках».
 * `push` — PushCenter (или его замена в тестах), `manager` — TaskManager.
 *
 * Повторный вызов с тем же id ничего не отправляет: сверка может пройти несколько
 * раз, а запуск завершается однажды.
 */
export function createInvocationNotifier({ manager, push, limit = 500 } = {}) {
  if (!push || typeof push.notify !== 'function') throw new TypeError('нужен push с методом notify');
  if (!manager) throw new TypeError('нужен manager');
  const seen = new Set();
  const lookup = id => {
    try { return manager.getInvocation(id); } catch { return null; }
  };
  return async function notifyFinishedInvocations(ids = []) {
    const sent = [];
    for (const id of ids) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (seen.size > limit) seen.delete(seen.values().next().value);
      const invocation = lookup(id);
      // Уведомляем только о запусках по расписанию: ручной запуск оператор и так ждёт.
      if (!invocation || invocation.trigger !== 'schedule') continue;
      const task = invocation.sessionId ? (manager.getTask?.(invocation.sessionId) ?? null) : null;
      let recipe = null;
      try { recipe = invocation.recipeId ? manager.getRecipe(invocation.recipeId) : null; } catch { recipe = null; }
      const notification = notificationForInvocation({
        invocation,
        policy: task?.scheduleNotify ?? null,
        recipeName: recipe?.name ?? null,
        task,
      });
      if (!notification) continue;
      try { await push.notify(notification); } catch { /* доставка не влияет на статус запуска */ }
      sent.push(notification);
    }
    return sent;
  };
}
