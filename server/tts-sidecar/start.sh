#!/usr/bin/env bash
# POSIX (macOS/Linux) counterpart of start.ps1 — launch the TTS sidecar via the
# venv python. Single-shot launcher; Node's sidecar-supervisor owns restart logic.
# See start.ps1 for the Windows version and the rationale behind each block.
# Kept bash 3.2-friendly.
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

# Launch uvicorn and propagate its exit code. main.py self-exits with one of
# two documented codes:
#   42 = CUDA device-side assert (context corrupted for the process lifetime;
#        only a fresh interpreter recovers).
#   43 = planned recycle (the memory watchdog self-exits when committed RAM or
#        reserved VRAM crosses the configured ceiling).
# Node's sidecar-supervisor owns the restart logic for both — this launcher is
# single-shot and always propagates the real exit code. See issue #3121.
cd "$here"
"$venv_python" -m uvicorn main:app --host "$bind_host" --port "$port"
exit $?
