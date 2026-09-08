@echo off
setlocal
cd /d "%~dp0"

if not exist config.json (
  copy /Y config.example.json config.json >nul
  echo [TaskBridge] Created config.json from config.example.json
  echo [TaskBridge] You can already test Scratch mode. Edit config.json to add real projects.
)

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js 20+ not found in PATH.
  exit /b 1
)

node src\server.mjs
