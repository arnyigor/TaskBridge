@echo off
rem ---------------------------------------------------------------------------
rem shutdown-pc.cmd - schedule a Windows shutdown with a cancel window.
rem
rem   shutdown-pc.cmd              shut down in 60 s (asks y/N first)
rem   shutdown-pc.cmd 300          shut down in 300 s
rem   shutdown-pc.cmd 0            shut down now (still asks y/N)
rem   shutdown-pc.cmd --force      also force-close apps that block shutdown
rem   shutdown-pc.cmd --dry-run    print the command instead of running it
rem   shutdown-pc.cmd --cancel     abort an already scheduled shutdown
rem
rem Cancel at any time before the deadline with:  shutdown /a
rem All messages are ASCII-only on purpose: the cmd.exe codepage of the caller
rem cannot be relied upon, and non-ASCII text turns into mojibake.
rem ---------------------------------------------------------------------------
setlocal EnableExtensions
set "DELAY=60"
set "DRY_RUN=0"
set "FORCE="

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--dry-run" goto flag_dry
if /i "%~1"=="-n"        goto flag_dry
if /i "%~1"=="--force"   goto flag_force
if /i "%~1"=="-f"        goto flag_force
if /i "%~1"=="--cancel"  goto do_cancel
if /i "%~1"=="-c"        goto do_cancel
if /i "%~1"=="--help"    goto usage
if /i "%~1"=="-h"        goto usage
if /i "%~1"=="/?"        goto usage
rem anything else must be a non-negative integer number of seconds
echo(%~1| findstr /r /c:"^[0-9][0-9]*$" >nul
if errorlevel 1 goto usage
set "DELAY=%~1"
shift
goto parse

:flag_dry
set "DRY_RUN=1"
shift
goto parse

:flag_force
set "FORCE=/f"
shift
goto parse

:do_cancel
echo [shutdown-pc] Aborting a pending shutdown...
shutdown /a
if errorlevel 1 goto nothing_pending
echo [shutdown-pc] Pending shutdown aborted.
exit /b 0

:nothing_pending
echo [shutdown-pc] Nothing to abort - no shutdown was pending.
exit /b 1

:parsed
if "%DRY_RUN%"=="1" (
  echo shutdown /s /t %DELAY% %FORCE% /c "TaskBridge: shutting down"
  exit /b 0
)

echo.
echo   This computer will SHUT DOWN in %DELAY% second(s).
echo   Unsaved work will be lost.
echo   Cancel before the deadline with:  shutdown /a
echo.
set "ANSWER="
set /p "ANSWER=Proceed? [y/N] "
if /i not "%ANSWER%"=="y" (
  echo [shutdown-pc] Cancelled - nothing was scheduled.
  exit /b 0
)

shutdown /s /t %DELAY% %FORCE% /c "TaskBridge: shutting down"
if errorlevel 1 goto schedule_failed

echo [shutdown-pc] Shutdown scheduled in %DELAY% s. Cancel with: shutdown /a
exit /b 0

:schedule_failed
echo [shutdown-pc] ERROR: could not schedule the shutdown.
exit /b 1

:usage
echo Usage: shutdown-pc.cmd [seconds] [--force] [--dry-run] [--cancel]
echo   seconds          delay before shutdown, default 60 (0 = now)
echo   --force, -f      force-close apps that block shutdown (shutdown /f)
echo   --dry-run, -n    print the command without running it
echo   --cancel, -c     abort a shutdown that is already scheduled
exit /b 2
