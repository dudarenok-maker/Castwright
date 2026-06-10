#!/usr/bin/env bash
# POSIX (macOS/Linux) counterpart of start.ps1 — launch the TTS sidecar via the
# venv python with a supervisor loop that restarts on the recoverable exit codes
# 42 (CUDA poison) and 43 (planned memory recycle). See start.ps1 for the Windows
# version and the rationale behind each block. Kept bash 3.2-friendly.
set -u
here="$(cd "$(dirname "$0")" && pwd)"

# venv defaults to .venv next to this script; SIDECAR_VENV_DIR overrides it so a
# versioned-dir install (fs-1) shares one venv across releases.
venv_dir="${SIDECAR_VENV_DIR:-$here/.venv}"
venv_python="$venv_dir/bin/python"
if [ ! -x "$venv_python" ]; then
  echo "Local TTS sidecar venv not found at $venv_python." >&2
  echo "Run the one-time setup first (see server/tts-sidecar/README.md):" >&2
  echo "  cd server/tts-sidecar && python3.11 -m venv .venv && ./.venv/bin/python -m pip install -r requirements.txt" >&2
  exit 1
fi

# Source sidecar-relevant keys from server/.env (whitelist COQUI_*, PRELOAD_COQUI,
# LOCAL_TTS_*) without clobbering an explicit shell export. Mirrors start.ps1.
env_file="$(cd "$here/.." && pwd)/.env"
if [ -f "$env_file" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; esac
    key="${line%%=*}"; val="${line#*=}"
    key="$(printf '%s' "$key" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    val="$(printf '%s' "$val" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    case "$val" in \"*\") val="${val#\"}"; val="${val%\"}" ;; \'*\') val="${val#\'}"; val="${val%\'}" ;; esac
    case "$key" in
      COQUI_*|PRELOAD_COQUI|LOCAL_TTS_*)
        eval "cur=\${$key:-}"
        [ -z "$cur" ] && export "$key=$val"
        ;;
    esac
  done < "$env_file"
fi

# Pre-accept the Coqui TOS so the first download doesn't prompt via input()
# (EOFError under non-interactive spawn). Local/personal-use only.
: "${COQUI_TOS_AGREED:=1}"; export COQUI_TOS_AGREED

port="${LOCAL_TTS_PORT:-9000}"
bind_host="${LOCAL_TTS_HOST:-127.0.0.1}"
restart_backoff=2

# Supervisor loop. main.py self-exits with one of two recoverable codes:
#   42 = CUDA device-side assert (context corrupted for the process lifetime;
#        only a fresh interpreter recovers).
#   43 = planned recycle (the memory watchdog self-exits when committed RAM or
#        reserved VRAM crosses the configured ceiling -- a fresh process resets
#        the leaked/spilled pool). This is REQUESTED recycling, not a crash, so
#        it must relaunch too.
# On either, we relaunch uvicorn so the next request hits a clean process.
# Any other exit code (0 normal shutdown, 1 syntax/import error, 130 Ctrl+C,
# etc.) breaks the loop so a real bug doesn't trap the supervisor in a tight
# crash-respawn cycle. Mirrors start.ps1 / sidecar-restart-policy.ps1.
cd "$here"
while true; do
  "$venv_python" -m uvicorn main:app --host "$bind_host" --port "$port"
  code=$?
  if [ "$code" -eq 42 ] || [ "$code" -eq 43 ]; then
    echo "[supervisor] sidecar exited with code $code - restarting in ${restart_backoff}s."
    sleep "$restart_backoff"
    continue
  fi
  echo "[supervisor] sidecar exited with code $code - not restarting."
  break
done
