// Маршруты автоматизаций: рецепты (MR-05), расписания и запуски (MR-06).
//
// Вынесены из server.mjs вместе с решением о доступе: у каждого маршрута оно
// объявлено рядом с обработчиком, а не «где-то выше в цепочке if». Обработчики
// остаются тонкими — вся логика в AutomationService и TaskManager.
export function registerAutomationRoutes(router, { manager, notifyFinishedInvocations }) {
  // --- Recipes (MR-05) ------------------------------------------------------
  router.get('/api/recipes', { auth: 'client' }, ({ res, url, json }) => {
    json(res, 200, { items: manager.listRecipes({ projectId: url.searchParams.get('projectId') }) });
  });
  router.post('/api/recipes', { auth: 'client' }, async ({ req, res, json, readJson }) => {
    json(res, 201, manager.createRecipe(await readJson(req)));
  });
  router.post('/api/recipes/:id/run', { auth: 'client' }, async ({ req, res, params, access, json, readJson }) => {
    const body = await readJson(req).catch(() => ({}));
    const started = await manager.runRecipe(params.id, {
      parameters: body.parameters ?? {},
      trigger: body.trigger === 'schedule' ? 'schedule' : 'manual',
      clientId: body.clientId ?? null,
      deviceId: access.device(req)?.deviceId,
    });
    json(res, 201, started);
  });
  router.get('/api/recipes/:id', { auth: 'client' }, ({ res, params, json }) => json(res, 200, manager.getRecipe(params.id)));
  router.patch('/api/recipes/:id', { auth: 'client' }, async ({ req, res, params, json, readJson }) => {
    json(res, 200, manager.updateRecipe(params.id, await readJson(req).catch(() => ({}))));
  });
  router.delete('/api/recipes/:id', { auth: 'client' }, ({ res, params, json }) => {
    json(res, 200, { ok: true, removed: manager.deleteRecipe(params.id) });
  });

  // --- Schedules (MR-06) ----------------------------------------------------
  router.get('/api/schedules', { auth: 'client' }, ({ res, url, json }) => {
    json(res, 200, { items: manager.listSchedules({ recipeId: url.searchParams.get('recipeId') }) });
  });
  router.post('/api/schedules', { auth: 'client' }, async ({ req, res, json, readJson }) => {
    json(res, 201, manager.createSchedule(await readJson(req)));
  });
  router.post('/api/schedules/:id/run', { auth: 'client' }, async ({ req, res, params, access, json, readJson }) => {
    const body = await readJson(req).catch(() => ({}));
    const invocation = await manager.runScheduleNow(params.id, {
      clientId: body.clientId ?? null,
      deviceId: access.device(req)?.deviceId,
    });
    json(res, 201, invocation);
  });
  router.get('/api/schedules/:id', { auth: 'client' }, ({ res, params, json }) => json(res, 200, manager.getSchedule(params.id)));
  router.patch('/api/schedules/:id', { auth: 'client' }, async ({ req, res, params, json, readJson }) => {
    json(res, 200, manager.updateSchedule(params.id, await readJson(req).catch(() => ({}))));
  });
  router.delete('/api/schedules/:id', { auth: 'client' }, ({ res, params, json }) => {
    json(res, 200, { ok: true, removed: manager.deleteSchedule(params.id) });
  });

  // «Выполнить тик сейчас»: диагностика расписаний, не дожидаясь 09:00, и то, чем
  // проверяются политики пропусков. Только на самой машине: это операция над ВСЕМИ
  // расписаниями сразу (для одного есть POST /api/schedules/:id/run).
  router.post('/api/scheduler/tick', { auth: 'local' }, async ({ req, res, json, readJson }) => {
    const body = await readJson(req).catch(() => ({}));
    const nowIso = typeof body.now === 'string' && !Number.isNaN(Date.parse(body.now)) ? new Date(body.now).toISOString() : undefined;
    const result = await manager.schedulerTick(nowIso ? { nowIso } : {});
    await notifyFinishedInvocations(result?.reconciled ?? []);
    json(res, 200, result);
  });

  // --- Invocations (история запусков, AUTO-03) ------------------------------
  router.get('/api/invocations', { auth: 'client' }, ({ res, url, json }) => {
    json(res, 200, {
      items: manager.listInvocations({
        recipeId: url.searchParams.get('recipeId'),
        scheduleId: url.searchParams.get('scheduleId'),
        status: url.searchParams.get('status'),
        limit: Number(url.searchParams.get('limit')) || 50,
        // История автоматизаций листается страницами (AUTO-03D).
        offset: Math.max(Number(url.searchParams.get('offset')) || 0, 0),
      }),
    });
  });
  // Компактная сводка запуска (AUTO-03B): отдельный запрос, чтобы история не тянула
  // детали при каждом обновлении списка. Не-GET на этом пути — 405, как и раньше.
  router.get('/api/invocations/:id/summary', { auth: 'client' }, ({ res, params, json }) => {
    json(res, 200, manager.invocationSummary(params.id));
  });
  router.all('/api/invocations/:id/summary', { auth: 'client' }, () => {
    throw Object.assign(new Error('Метод не поддерживается.'), { code: 'METHOD_NOT_ALLOWED' });
  });
  router.get('/api/invocations/:id', { auth: 'client' }, ({ res, params, json }) => json(res, 200, manager.getInvocation(params.id)));
}
