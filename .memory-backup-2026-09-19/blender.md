# Проект: blender | Срез от 2026-09-13 21:50

# Blender MCP (official, lab/blender_mcp) — установлено

Офиц. проект Blender Lab: https://projects.blender.org/lab/blender_mcp (GPL-3.0, автор Dalai Felinto).
Docs: https://www.blender.org/lab/mcp-server/ . Требует Blender >= 5.1.

## Что стоит локально
- Blender 5.2.0 LTS: `C:\Program Files\Blender Foundation\Blender 5.2\blender.exe`
- Репо (клон, для сервера): `G:\AIModels\MCPs\blender_mcp` (HEAD ff54e4d)
- Аддон-расширение (id=mcp, v1.0.0): установлено и включено
  `%APPDATA%\Blender Foundation\Blender\5.2\extensions\user_default\mcp`
- Сервер: Python-пакет в `G:\AIModels\MCPs\blender_mcp\mcp`, venv создан через `uv sync`
- pi MCP запись "blender": `uv --directory G:/AIModels/MCPs/blender_mcp/mcp run blender-mcp`
  env: BLENDER_MCP_PORT=9876, BLENDER_PATH=<blender.exe>; нужен рестарт pi, чтобы подхватилась.

## Архитектура / факты
- MCP client --stdio--> blender-mcp --TCP(localhost:9876)--> add-on в Blender.
- 26 инструментов (execute_blender_code, get_*_summary[_for_cli], search_api_docs, screenshots, render_*...).
- Сервер стартует/отдаёт tools/list даже без запущенного Blender (коннект ленивый, на вызове).
- Add-on требует "Online access" в System preferences; autostart по умолчанию ON.
- Есть weak_sandbox.py: блокирует sys.exit, wm.quit_blender, wm.read_factory_settings (не полноценный sandbox).

## Верификация (проведена)
- build+install-file: `blender --command extension build --source-dir addon/blender_mcp_addon --output-dir _build_out`
  затем `blender --command extension install-file -r user_default -e _build_out/mcp-1.0.0.zip`
- E2E: `_misc/blender_mcp_verify_e2e.py` -> PASS. execute_blender_code вернул {version: 5.2.0 LTS}.
- Гочи: официальный tests/mcp_client использует select() на pipe -> на Windows WinError 10038.
  Для Windows нужен reader-поток+queue (см. _misc/blender_mcp_verify_e2e.py).

## Запуск вручную (headless bridge)
`"<blender.exe>" --online-mode --background --command blender_mcp --port 9876`
`uv --directory G:/AIModels/MCPs/blender_mcp/mcp run blender-mcp` (env BLENDER_MCP_PORT=9876)

## Другое
- `G:\AIModels\MCPs\blender-mcp` = НЕофиц. community проект (github ahujasid/blender-mcp) — отдельный.