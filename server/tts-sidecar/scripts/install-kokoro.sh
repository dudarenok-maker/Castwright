#!/usr/bin/env bash
# install-kokoro.sh -- POSIX counterpart to install-kokoro.ps1. Downloads the
# Kokoro v1 ONNX model + voices manifest into ../voices/kokoro/ so the sidecar
# can preload them on boot.
#
# Idempotent: re-runs skip files that already exist with non-zero size.
# Failure-tolerant: a half-finished download is removed so the next run
# retries cleanly. Pure bash + curl -- no extra dependencies.
#
# Tested on macOS (zsh + bash) and Ubuntu/Debian. The .ps1 variant remains
# the Windows path.

set -euo pipefail

MODEL_URL="${MODEL_URL:-https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx}"
VOICES_URL="${VOICES_URL:-https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin}"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
TARGET_DIR="${TARGET_DIR:-${SCRIPT_DIR}/../voices/kokoro}"

mkdir -p "${TARGET_DIR}"
TARGET_DIR="$( cd "${TARGET_DIR}" && pwd )"

log() {
    echo "[install-kokoro] $*"
}

download() {
    local url="$1"
    local dest="$2"
    local name
    name="$( basename "${dest}" )"

    if [[ -f "${dest}" ]]; then
        local size
        size="$( wc -c < "${dest}" | tr -d ' ' )"
        if [[ "${size}" -gt 0 ]]; then
            local mb=$(( size / 1024 / 1024 ))
            log "Skipping ${name} -- already present (${mb} MB)."
            return 0
        fi
        # Zero-byte file from a prior failed run -- nuke and retry.
        rm -f "${dest}"
    fi

    log "Downloading ${name} from ${url}"
    if ! curl -fL --retry 3 --retry-delay 2 -o "${dest}" "${url}"; then
        rm -f "${dest}"
        log "FAIL: download of ${name} failed."
        exit 1
    fi

    local size
    size="$( wc -c < "${dest}" | tr -d ' ' )"
    if [[ "${size}" -lt 1024 ]]; then
        rm -f "${dest}"
        log "FAIL: ${name} is only ${size} bytes -- looks like an error page, not the real weights."
        exit 1
    fi
    local mb=$(( size / 1024 / 1024 ))
    log "Downloaded ${name} (${mb} MB)"
}

download "${MODEL_URL}"  "${TARGET_DIR}/kokoro-v1.0.onnx"
download "${VOICES_URL}" "${TARGET_DIR}/voices-v1.0.bin"

log "Done. Restart the sidecar to pick up the new weights."
