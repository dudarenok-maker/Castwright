' Flash-free launcher for start-app.ps1.
'
' Windows shows a console window for any .bat file until it exits — that's
' the first of the two flashing windows the user used to see when running
' start-app.bat. The second came from npm.cmd / powershell.exe spawns inside
' start-app.ps1 (fixed separately by routing each spawn through `cmd.exe /s
' /c` so -WindowStyle Hidden is honored).
'
' VBS files run under wscript.exe, which has NO console. Running PowerShell
' from here with WindowStyle 0 (hidden) starts the whole chain with no
' visible window at all. start-app.bat now does `start "" wscript ... & exit`
' so the bat window flashes for ~50ms then closes.
'
' On startup failure: PowerShell exits non-zero and writes the diagnostic to
' logs\start-failed.txt. We open that file in Notepad so the user actually
' sees what broke — without this, a silent fail looks like the .bat did
' nothing at all.

Option Explicit

Dim sh, fs, scriptDir, repoRoot, ps1Path, cmd, rc, failLog

Set sh = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")

' scripts\start-app-hidden.vbs  →  repo root is two levels up.
scriptDir = fs.GetParentFolderName(WScript.ScriptFullName)
repoRoot  = fs.GetParentFolderName(scriptDir)
ps1Path   = repoRoot & "\scripts\start-app.ps1"
failLog   = repoRoot & "\logs\start-failed.txt"

cmd = "powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File """ & ps1Path & """"

' Run synchronously (third arg True) so we can inspect the exit code and
' surface the fail log if anything went wrong. Window style 0 = hidden.
rc = sh.Run(cmd, 0, True)

If rc <> 0 Then
  If fs.FileExists(failLog) Then
    sh.Run "notepad.exe """ & failLog & """", 1, False
  Else
    MsgBox "Startup failed (exit " & rc & ") and no diagnostic log was written." _
      & vbCrLf & vbCrLf _
      & "Run scripts\start-app.ps1 directly in a PowerShell window to see the error.", _
      vbExclamation, "Audiobook Generator"
  End If
End If
