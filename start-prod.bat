@echo off
REM ===========================================================================
REM Start the Audiobook Generator in PRODUCTION mode (built bundle, no watcher).
REM Double-click this file, or run it from a terminal. The server is launched
REM detached, so it keeps running after this window closes. Logs go to
REM logs\server.log; stop it later with stop-prod.bat.
REM ===========================================================================
cd /d "%~dp0"

call npm run --silent start:prod
if errorlevel 1 (
  echo.
  echo [start-prod] Launch failed. If the bundle is missing, build it first:
  echo                npm run build
)

echo.
pause
