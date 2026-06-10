#requires -Version 5.1
# Pester 5.x tests for server\tts-sidecar\start.ps1 — fs-1 SIDECAR_VENV_DIR knob.
# Invoke via scripts\tests\run.ps1 (npm run test:scripts).
#
# A versioned-dir install (fs-1) shares ONE multi-GB venv across releases by
# pointing SIDECAR_VENV_DIR at <install>\venv instead of the per-release
# .venv next to start.ps1. These tests pin that the launcher honours the env
# var (and falls back to .venv when unset) WITHOUT having to boot uvicorn:
# when the resolved venv python is absent, start.ps1 writes a precise error
# naming the path it looked at and exits non-zero — so the error text proves
# which path the venv resolution chose.

BeforeAll {
    $script:startScript = Join-Path $PSScriptRoot "..\..\server\tts-sidecar\start.ps1"

    # The PowerShell host running these tests: powershell.exe on Windows,
    # pwsh on the Linux CI runner. Hardcoding 'powershell.exe' fails on Linux
    # ("No such file or directory"); resolve the current host instead. The
    # start.ps1 venv-check we exercise is portable enough to run under either.
    $script:pwshExe = (Get-Process -Id $PID).Path

    # Run start.ps1 in a child PowerShell and capture exit code + output.
    # NB: use Start-Process with redirected files, NOT `& powershell ... 2>&1`
    # — in 5.1 a native command's stderr becomes ErrorRecords that, under
    # Pester's $ErrorActionPreference='Stop', re-throw in THIS runspace before
    # our assertions run.
    function Invoke-StartScript {
        param(
            [string] $ScriptPath,
            [string] $VenvDir,           # unset → fall through to .venv default
            [switch] $SetVenvDir
        )
        $prev = $env:SIDECAR_VENV_DIR
        if ($SetVenvDir) { $env:SIDECAR_VENV_DIR = $VenvDir }
        else { Remove-Item Env:\SIDECAR_VENV_DIR -ErrorAction SilentlyContinue }
        $outFile = [System.IO.Path]::GetTempFileName()
        $errFile = [System.IO.Path]::GetTempFileName()
        try {
            $p = Start-Process -FilePath $script:pwshExe `
                -ArgumentList @('-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', $ScriptPath) `
                -Wait -PassThru -NoNewWindow `
                -RedirectStandardOutput $outFile -RedirectStandardError $errFile
            $text = (Get-Content $outFile -Raw -ErrorAction SilentlyContinue) +
                    (Get-Content $errFile -Raw -ErrorAction SilentlyContinue)
            # Windows PowerShell wraps Write-Error text at the inherited console
            # width, which can split an asserted venv path mid-GUID (narrow
            # consoles ~104 cols flake both Its). The assertions only ever match
            # path substrings, so flatten the line breaks before they see it.
            $text = $text -replace '\r?\n', ''
            return [pscustomobject]@{ ExitCode = $p.ExitCode; Output = $text }
        } finally {
            if ($null -eq $prev) { Remove-Item Env:\SIDECAR_VENV_DIR -ErrorAction SilentlyContinue }
            else { $env:SIDECAR_VENV_DIR = $prev }
            Remove-Item $outFile, $errFile -Force -ErrorAction SilentlyContinue
        }
    }
}

Describe 'start.ps1 SIDECAR_VENV_DIR resolution' {
    It 'looks for the venv python under SIDECAR_VENV_DIR when it is set' {
        $missing = Join-Path ([System.IO.Path]::GetTempPath()) "fs1-novenv-$([Guid]::NewGuid())"
        $result = Invoke-StartScript -ScriptPath $script:startScript -VenvDir $missing -SetVenvDir

        # No python.exe under the env-pointed dir → the venv check fails fast,
        # before any uvicorn launch, and exits non-zero.
        $result.ExitCode | Should -Not -Be 0
        # The error names the exact path it probed — the env-pointed dir —
        # proving SIDECAR_VENV_DIR drove the resolution (not the default).
        $result.Output | Should -Match ([regex]::Escape($missing))
    }

    It 'falls back to the script-local .venv when SIDECAR_VENV_DIR is unset' {
        # Run from a throwaway copy of the script with NO .venv beside it, so
        # the fallback path is guaranteed absent regardless of the dev box's
        # real .venv. The error must name a `.venv` path next to the script.
        $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "fs1-sidecar-$([Guid]::NewGuid())"
        New-Item -ItemType Directory -Path $tmpDir | Out-Null
        try {
            $copied = Join-Path $tmpDir 'start.ps1'
            Copy-Item $script:startScript $copied
            $result = Invoke-StartScript -ScriptPath $copied

            $result.ExitCode | Should -Not -Be 0
            $result.Output | Should -Match ([regex]::Escape((Join-Path $tmpDir '.venv')))
        } finally {
            Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
