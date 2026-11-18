@echo off
rem One-time (re-runnable) TaskBridge setup. Double-click, confirm UAC.
rem It registers scheduled task "TaskBridge" (RunLevel Highest, at logon and
rem every 3 minutes) which runs the hidden watchdog `taskbridge ensure`, and
rem points the Startup shortcut at a NON-elevated UI launcher. A server started
rem by the task — and every process it spawns — runs elevated, so restarts can
rem stop elevated models and remove an elevated orphan from the public port.
setlocal EnableExtensions

rem Root resolution, in order: TASKBRIDGE_ROOT (set by a Desktop wrapper),
rem first argument, then the parent of this script. The Desktop copy is not in
rem the repository, so it must set TASKBRIDGE_ROOT instead of relying on %~dp0.
set "ROOT=%TASKBRIDGE_ROOT%"
if not defined ROOT if not "%~1"=="" set "ROOT=%~1"
if not defined ROOT set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
if not exist "%ROOT%\scripts\start-lan.mjs" (
  echo ERROR: TaskBridge root not found: "%ROOT%"
  echo        Expected: %ROOT%\scripts\start-lan.mjs
  echo        Set TASKBRIDGE_ROOT or pass the root as the first argument.
  pause
  exit /b 1
)

if defined TASKBRIDGE_SETUP_CHECK_ONLY (
  echo TASKBRIDGE_ROOT_OK=%ROOT%
  exit /b 0
)

net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
  exit /b
)

set "NODE="
for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE set "NODE=%%N"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE (
  echo ERROR: node.exe not found in PATH or %%ProgramFiles%%\nodejs.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\scripts\taskbridge-task-setup.ps1" -Root "%ROOT%" -Node "%NODE%"
if errorlevel 1 (
  echo.
  echo FAILED to install the TaskBridge task.
  pause
  exit /b 1
)

echo.
echo Start now without rebooting:  schtasks /run /tn TaskBridge
echo Undo:  schtasks /delete /tn TaskBridge /f
pause
