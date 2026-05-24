---
status: stable
shipped: 2026-05-24
owner: null
---

# MP3 Xing/Info VBR header (correct chapter duration in players)

> Status: stable
> Key files: `server/src/tts/mp3.ts`, `src/components/mini-player.tsx`, `scripts/rexing-existing.mjs`
> URL surface: `#/books/<id>/listen` (mini-player), indirect via generation
> OpenAPI ops: none (encoder + repair tooling)

## Benefit / Rationale

- **User:** the mini-player's scrubber total now matches the chapter card. Before this, a 10:34 chapter showed as ~76:18 in the player (and seeking landed in the wrong place), because the on-disk MP3 had no reliable duration.
- **Technical:** every chapter MP3 now ships a Xing/Info VBR header, so ffprobe, browsers, and third-party players all read the true duration without decoding the whole file. The repair script back-fills the entire existing library losslessly (stream copy, no re-encode).
- **Architectural:** locks in that VBR MP3 output must be seekable so libmp3lame can stamp the header — a constraint that pipe-to-stdout silently violated.

## Context / root cause

`encodePcmToAudio` (`server/src/tts/mp3.ts`) piped libmp3lame's output to `pipe:1` (non-seekable stdout) and collected the bytes. LAME writes the Xing VBR header by seeking back to the file start **after** encoding to fill in the final frame count — impossible on a pipe, so the header was silently dropped. Without it, ffprobe and browsers estimate `duration = filesize×8 ÷ sampled-bitrate`; the quiet, low-bitrate chapter lead-in makes that estimate ~7× too long. The audio frames themselves were always correct (they decode to the right length) — only the container's duration estimate was wrong.

This affected **every MP3 the tool had ever produced** (verified across multiple books, all ~7.1–7.2×). It is distinct from the 2026-05-21 loudnorm sample-rate stretch (archive plan 71, commit `137cb69`) — that fix corrected a genuine audio-speed defect and remains in place.

## Architectural impact

- **New seam:** `FfmpegBuildOpts.outputPath`. When set, `buildMp3FfmpegArgs` writes to that seekable file (plus an explicit `-write_xing 1`) instead of `pipe:1`. `encodePcmToAudio` allocates a unique temp file under `os.tmpdir()` for the MP3 path, reads it back into the Buffer it already contracts to return, and unlinks it (including on the failure path). AAC/M4A and Opus are unchanged — they stream to `pipe:1` and carry reliable duration metadata (fragmented-MP4 `trun`, Ogg granule positions).
- **Invariants preserved:** the output `-ar` pin from plan 71 is untouched (still between `-af` and `-c:a`); `-q:a` VBR quality unchanged; `encodePcmToAudio(...) => Promise<Buffer>` signature unchanged, so `generation.ts` (`writeFile(tmpAudio, audioBuffer)` then atomic rename) needs no edit.
- **Frontend (defensive):** `mini-player.tsx` `onLoadedMetadata` no longer clobbers a positive server-provided `durationSec` (from `segments.json`, served by `chapter-audio.ts`) with the browser's estimate. This makes the displayed total correct immediately, even on a not-yet-repaired legacy file.
- **Migration / repair:** `scripts/rexing-existing.mjs` remuxes existing MP3s with `ffmpeg -c:a copy -write_xing 1` (lossless). Idempotent — files that already carry a Xing/Info header are skipped, so it is safe to re-run. Never touches `.segments.json` / `.peaks.json` / `.lufs.json`. No full regeneration required.
- **Reversibility:** revert the three source edits and future encodes return to piping. The Xing headers already stamped on disk are valid MP3 and remain correct.

## Invariants to preserve

- `buildMp3FfmpegArgs` MP3 output target is a seekable file (`opts.outputPath`), not `pipe:1`, and the arg list contains `-write_xing 1` — `server/src/tts/mp3.ts` `buildMp3FfmpegArgs`; locked by `server/src/tts/mp3-spawn-args.test.ts` (`mp3 output target`).
- The loudnorm output `-ar` pin stays strictly between `-af` and `-c:a` for all three codecs — locked by `mp3-spawn-args.test.ts` (`$format loudnorm output rate pinning`).
- An encoded MP3's container duration matches the PCM duration within ~0.15 s and carries a Xing/Info header — locked by `server/src/tts/mp3.test.ts` (ffprobe-duration regression).
- `mini-player.tsx` never overwrites a positive `audio.durationSec` with the `<audio>` element's `duration` — locked by `src/components/mini-player.test.tsx` (`plan 109 duration source of truth`).

## Test plan

### Automated coverage

- Vitest server (`server/src/tts/mp3-spawn-args.test.ts`) — MP3 output target is a temp file (not `pipe:1`) with `-write_xing 1`; AAC/Opus keep `pipe:1`; loudnorm `-ar` window intact. Adds a `node:fs/promises` `readFile`/`unlink` mock so the read-back works under the faked spawn.
- Vitest server (`server/src/tts/mp3.test.ts`) — real-ffmpeg: a 3.0 s PCM encodes to an MP3 whose ffprobe `format=duration` is within 0.15 s of 3.0 (was ~21 s) and contains a Xing/Info header. Skips cleanly if ffprobe is absent.
- Vitest unit (`src/components/mini-player.test.tsx`) — a server `durationSec: 634` survives an inflated `4578` `loadedmetadata` (total renders `10:34`, not `76:18`); falls back to the browser value when the server gave `0`.
- `node:test` script (`scripts/tests/rexing-existing.test.mjs`) — `hasXingHeaderInBuffer` detects Xing/Info (incl. after an ID3v2 tag) and returns false otherwise; `iterMp3s` yields every `*.mp3` (incl. `.previous.mp3`), ignores sidecars + `.tmp-*`, tolerates a missing books root. Discovered by `npm run test:hooks`.

### Manual acceptance walkthrough

1. Generate (or regenerate) one chapter. `ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 <slug>.mp3` ≈ the card / `segments.json durationSec` (was ~7.2×). The first 4 KiB of the file contain `Xing`.
2. `node scripts/rexing-existing.mjs --dry-run --workspace <ws>` lists pre-fix MP3s and modifies nothing. A real run stamps headers in place; a re-run reports `repaired 0, alreadyTagged N`. Sidecar mtimes unchanged.
3. Open the Listen view on a repaired chapter — the player total equals the card (e.g. 10:34); scrubbing lands correctly.

## Out of scope

- AAC/M4A and Opus output (carry reliable duration without a seek-back; unchanged).
- MediaSource/range-request streaming playback (BACKLOG Must #2).

## Ship notes

Shipped 2026-05-24 on branch `fix/server-mp3-xing-header-duration`. Three source edits (encoder + mini-player guard + repair script) plus paired tests across all four harnesses. The encoder fix corrects all new audio; `scripts/rexing-existing.mjs` losslessly repairs the existing library (no regeneration needed). Commit SHAs: see the merged PR.
