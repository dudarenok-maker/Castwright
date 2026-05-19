#!/usr/bin/env bash
# install-coqui.sh -- pre-fetch the Coqui XTTS v2 model weights so the
# sidecar doesn't pay the ~2 GB download tax on the first synth call.
#
# Plan 61: parallel to install-kokoro.sh, ships in the release bundle
# so a deployer who wants XTTS doesn't have to drop to a terminal.
#
# Strategy:
#   The official path is `coqui-tts` / `TTS` Python lib's auto-downloader.
#   We invoke it directly from the sidecar venv with TTS_HOME pointed at
#   the sidecar's `voices/coqui/` so the weights land in a known place
#   (vs. the per-user $HOME/.local/share/tts default).
#
#   The first import triggers the download from
#     https://huggingface.co/coqui/XTTS-v2 (model.pth + config.json +
#     vocab.json + speakers_xtts.pth)
#   into TTS_HOME. Total ~1.8 GB. We don't re-download if the manifest
#   directory already exists -- the Python lib handles idempotency.
#
# Idempotent: re-runs skip when XTTS-v2 is already present.
# Failure-tolerant: a half-finished download leaves a partial dir that
# the Python lib will resume on next run.
#
# Cross-platform: tested on macOS (zsh + bash) and Ubuntu/Debian. The
# .ps1 variant remains the Windows path.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SIDECAR_DIR="$( cd "${SCRIPT_DIR}/.." && pwd )"
TARGET_DIR="${TARGET_DIR:-${SIDECAR_DIR}/voices/coqui}"

log() {
    echo "[install-coqui] $*"
}

# Locate the sidecar venv's python. Two layouts to support:
#   - server/tts-sidecar/.venv/bin/python   (POSIX)
#   - server/tts-sidecar/.venv/Scripts/python.exe (Windows under WSL, etc.)
# We prefer POSIX; if neither exists, we ask the user to bootstrap the venv.
PY=""
if [[ -x "${SIDECAR_DIR}/.venv/bin/python" ]]; then
    PY="${SIDECAR_DIR}/.venv/bin/python"
elif [[ -x "${SIDECAR_DIR}/.venv/bin/python3" ]]; then
    PY="${SIDECAR_DIR}/.venv/bin/python3"
else
    log "FAIL: sidecar venv not bootstrapped at ${SIDECAR_DIR}/.venv."
    log "      Run 'python3 -m venv .venv && .venv/bin/pip install -r requirements.txt'"
    log "      from ${SIDECAR_DIR} first, then re-run this script."
    exit 1
fi

mkdir -p "${TARGET_DIR}"

# Skip the download when the model dir already has the manifest files
# the XTTS loader expects. The lib persists into
# $TTS_HOME/tts/tts_models--multilingual--multi-dataset--xtts_v2/
# but we set TTS_HOME so it lands directly under TARGET_DIR.
XTTS_DIR="${TARGET_DIR}/tts/tts_models--multilingual--multi-dataset--xtts_v2"
if [[ -f "${XTTS_DIR}/model.pth" && -f "${XTTS_DIR}/config.json" ]]; then
    log "Skipping -- XTTS v2 weights already present at ${XTTS_DIR}"
    exit 0
fi

log "Pre-fetching XTTS v2 into ${TARGET_DIR} via the TTS lib (~1.8 GB, expect 2-5 min on a fast link)..."

# The Python TTS lib agrees to a license click-through on first use; we
# auto-accept here since the script's invocation is itself the consent.
# TOS env var is the documented bypass:
#   https://github.com/coqui-ai/TTS/blob/main/TTS/utils/manage.py
export TTS_HOME="${TARGET_DIR}"
export COQUI_TOS_AGREED=1

if ! "${PY}" -c "from TTS.api import TTS; TTS('tts_models/multilingual/multi-dataset/xtts_v2')"; then
    log "FAIL: XTTS v2 pre-fetch failed. Check network + sidecar venv."
    exit 1
fi

# Sanity check.
if [[ ! -f "${XTTS_DIR}/model.pth" ]]; then
    log "FAIL: model.pth not at ${XTTS_DIR} after fetch. Lib changed path?"
    exit 1
fi

SIZE=$( wc -c < "${XTTS_DIR}/model.pth" | tr -d ' ' )
MB=$(( SIZE / 1024 / 1024 ))
log "Done. XTTS v2 weights at ${XTTS_DIR} (model.pth ${MB} MB)."
log "Restart the sidecar with PRELOAD_COQUI=1 to eagerly load on boot,"
log "or leave defaults to load XTTS lazily on first synth call."
