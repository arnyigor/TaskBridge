# Проект: taskbridge | Срез от 2026-09-16 09:41

# TaskBridge: сверка состояния и плана (2026-09-16)

## Проверено
- HEAD a4c2a89, version 0.9.6, master (ahead origin на 110).
- `npm run check` ✅; `npm test` ✅ 446 тестов: 444 pass, 0 fail, 2 skip (~53с).
  Skip: cloud-postgres (нет TASKBRIDGE_TEST_DATABASE_URL), cloud-web DOM-кадры.
- Незакоммичено (готово, тесты зелёные): src/task-manager.mjs (#resolvePiModelId
  async + fallback modelCatalog.list(), quant в основном матче);
  tests/manager.test.mjs (retry fs.rm на EBUSY, workspacePath до рестарта).
- Untracked: docs/project-dump/, zen_page.html.

## Планы
- FIX_PLAN.md — все 14 пунктов закрыты.
- docs/TaskBridge_TZ_v3.md — УСТАРЕЛ (дата 11.09, 0.6.0/HEAD 8a023f7), чекбоксы не верны.
  Добавлена шапка со ссылкой на новый отчёт.
- НОВЫЙ: docs/status-review-2026-09-16.md — сверка этапов 0-8.

## Статус этапов (по коду)
- 0 baseline/cloud: частично (живой Vercel не проверен).
- 1 доступ клиента: частично — web/app.js visibilitychange зовёт только checkPcState;
  auth.enabled=false в примере; нет постраничной догрузки backlog.
- 2 Session/Run/Command: каркас есть (src/session-manager.mjs, src/runners/pi-runner.mjs
  — аддитивные, НЕ подключены), таблицы runs/commands в task-store.mjs.
- 3 command ledger/мультиклиент: в основном сделано — #withCommand (commandId/clientId/
  payloadHash/статусы ACCEPTED..UNKNOWN_AFTER_CRASH), GET /api/commands/:id.
- 4 CLI: bin/taskbridge.mjs = start|stop|status|open|doctor (НЕ pi/attach). Импорт
  сессий: POST /api/tasks/from-session, src/native-sessions.mjs. taskbridge pi убран из P0.
- 5 AgentHost: частично — LAN app+proxy split, нет agent-host.mjs/IPC.
- 6 результат/diff/repair: частично — baseCommit, apply, verification; нет resultRevision/
  keepBranch/autoRepair/повторной сборки patch.
- 7 очередь/ресурсы: частично — capacity-1 queue, pending-files.json переживает рестарт,
  busy через /slots; планировщика ресурсов нет.
- 8 доп.runners: не начато.

## Следующие шаги
1) закоммитить 2 файла; 2) этап 1 (visibilitychange→refresh, auth default, paging);
3) этап 2 (довести SessionManager/PiRunner); 4) этап 6 (resultRevision/diff/keep);
5) этап 5/7 (AgentHost IPC + scheduler).