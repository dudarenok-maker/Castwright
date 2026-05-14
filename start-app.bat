@echo off
REM Hand off to the VBS shim that runs PowerShell hidden, then exit so this
REM bat's own console window closes immediately. The bat window still
REM flashes for ~50ms — Windows has no way to suppress a double-clicked .bat
REM entirely — but the VBS chain that follows is genuinely windowless. The
REM previous version stayed visible for the whole startup wait + flashed two
REM more npm.cmd windows; this is the minimum-visibility path on Windows.
start "" wscript.exe "%~dp0scripts\start-app-hidden.vbs"
exit /b 0
