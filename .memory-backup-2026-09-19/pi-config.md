# Проект: pi-config | Срез от 2026-09-14 02:21

# Pi: модель состояния (extension model-state)
## Текущее состояние (2026-09-14, все фиксы применены)
- `~/.pi/agent/extensions/model-state/index.ts` — вывод в НИЖНЮЮ СТРОКУ (ctx.ui.setStatus "model-state"), как llama.cpp Web UI.
- Формат: `PP 1549.5 | TG 43.7 tok/s · qwen-27b-q3 · KV 17% · GPU 15.0/15.9 GiB 31W 3% · CPU 5% RAM 27.0/109.0 GiB`.
- ГЛАВНЫЙ ФИКС: gauge `llamacpp:prompt_tokens_seconds`/`predicted_tokens_seconds` в llama.cpp НЕНАДЁЖНЫ (торчат на 0). Скорости считаются из счётчиков: PP = prompt_tokens_total/prompt_seconds_total, TG = tokens_predicted_total/tokens_predicted_seconds_total; мгновенная скорость — по дельтам между опросами (2.5с).
- Провайдер локальной модели = "llama.cpp" (с точкой) в LOCAL_PROVIDERS, иначе isLocal=false.
- llama-server на ДИНАМИЧЕСКОМ порту, автодетект из /v1/models (status.args --port); 8080 = pi-models-manager.
- KV % = n_tokens_max / n_ctx (/props). GPU: nvidia-smi. CPU: os.cpus дельты. RAM: os.totalmem-freemem.
- Облачные: только TG из стриминга. Команда /modelstate. Load-маркер: logs/model-state.jsonl.
- Для мобилы копировать index.ts на телефон (~/.pi/agent/extensions/model-state/) + рестарт pi.
- task-telemetry: тоже исправлен LOCAL_PROVIDERS ("llama.cpp").