@echo off
powershell.exe -ExecutionPolicy Bypass -NoProfile -File "%~dp0scripts\start-app.ps1"
if errorlevel 1 (
  echo.
  echo Startup failed. See logs\start-failed.txt for details.
  pause
)
