@echo off
REM ===========================================================================
REM Stop the PRODUCTION Audiobook Generator started by start-prod.bat.
REM Kills the server + its TTS sidecar (via .run\*.pid), then sweeps any
REM leftover listeners on :8080 / :9000.
REM ===========================================================================
cd /d "%~dp0"

call npm run --silent stop:prod

echo.
pause
