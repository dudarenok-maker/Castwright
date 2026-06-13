---
status: stable
shipped: 2026-05-20
owner: null
---

# AAC/M4A and Opus chapter audio output

> Status: stable
> Key files: `server/src/tts/mp3.ts`, `server/src/workspace/scan.ts`, `server/src/workspace/chapter-audio-file.ts`, `server/src/routes/generation.ts`, `server/src/routes/chapter-audio.ts`, `server/src/routes/book-state.ts`, `server/src/routes/export.ts`, `server/src/export/build-codec-zip.ts`, `server/src/export/build-mp3-zip.ts`, `src/modals/export-audiobook.tsx`, `src/lib/export-queue-adapter.ts`, `openapi.yaml`
> URL surface: `GET /api/books/:bookId/chapters/:chapterId/audio` (URL field varies per format), `GET …/audio.mp3` | `/audio.m4a` | `/audio.ogg`, `POST /api/books/:bookId/exports` (`format ∈ {mp3-zip, m4b, mp3-folder, aac-m4a-zip, opus-ogg-zip}`)
> OpenAPI ops: `BookExportRequest` / `BookExportJob` (`format` enum widened)
> Paired tests: `server/src/tts/aac.test.ts`, `server/src/tts/opus.test.ts`, `server/src/workspace/chapter-audio-file.test.ts`, `server/src/workspace/book-state-audio-format.test.ts`, `src/modals/export-audiobook.test.tsx`
> Cross-links: [28 — Chapter audio format](28-chapter-audio-format.md), [32 — Audiobook export](32-audiobook-export.md), [34 — MP3-folder export](34-mp3-folder-export.md)

## Benefit / Rationale

- **User:** smaller files at the same perceived quality. A 10-hour audiobook in MP3 V2 ≈ 600 MB; the same content in AAC ≈ 450 MB and in Opus ≈ 330 MB. Folks shipping books to phones over slow links or with tight storage can pick the lighter container.
- **User:** native iOS / Apple Books prefer AAC; Android-side audiobook players (Voice, VLC, Audiobookshelf) handle Opus best of the three. A per-book toggle lets the library reflect those preferences without retroactively re-encoding existing books.
- **Technical:** the encoder seam (`encodePcmToAudio` in `server/src/tts/mp3.ts`) widens from MP3-only to a discriminated dispatch (`mp3 | aac-m4a | opus`); each codec lives in its own arg builder. Adding FLAC or AC3 in the future is a one-builder follow-up, not a re-think.
- **Architectural:** the file-format choice is per-book, stored in `BookStateJson.audioFormat`. Books generated under plan 72 carry the field; older state files default to `'mp3'` at the read seam (`bookStateAudioFormat`). No retroactive migration, no schema bump.

## Supported formats

| Format     | Encoder           | Target bitrate     | Container         | File extension |
| ---------- | ----------------- | ------------------ | ----------------- | -------------- |
| `mp3`      | libmp3lame        | VBR V2 ≈ 140-185k  | MP3               | `.mp3`         |
| `aac-m4a`  | libfdk_aac (vbr 4) | ≈ 128 kbps          | MP4 (m4a)         | `.m4a`         |
| `aac-m4a`  | aac (native)      | CBR 128k           | MP4 (m4a)         | `.m4a`         |
| `opus`     | libopus (app=audio) | VBR 96k            | Ogg               | `.ogg`         |

### libfdk_aac fallback

`hasLibFdkAac()` probes `ffmpeg -codecs` once per process and caches the result. The free-software ffmpeg builds (and the Windows static builds that `scripts/install-ffmpeg.ps1` typically pulls) usually ship without libfdk_aac for licensing reasons; the encoder transparently falls back to the native `aac` encoder at 128 kbps CBR. Quality is comparable in this bitrate range; no user-visible difference for narration content.

### Container choice rationale

- **AAC in M4A (mp4 audio) via the `mp4` muxer with `+empty_moov+frag_keyframe+faststart`** — `ipod` is the conventional muxer but rejects non-seekable output (stdin/stdout pipes); fragmented MP4 IS pipe-friendly and the encoded files play in iOS, VLC, and Audiobookshelf without further treatment.
- **Opus in Ogg, not raw `.opus`** — broader player support (Audible/PocketBook recognise `.ogg` but not `.opus`). Same Opus stream; the wrapping differs.

## Architectural impact

- **Seam added:** `EncodePcmAudioFormat` union in `server/src/tts/mp3.ts` is now `'mp3' | 'aac-m4a' | 'opus'`. Each format has a private `build<Format>FfmpegArgs(opts)` helper; the public `encodePcmToAudio` dispatches on `opts.format ?? 'mp3'`.
- **Field added:** `BookStateJson.audioFormat?: 'mp3' | 'aac-m4a' | 'opus'`. Absent on legacy state.json files; the `bookStateAudioFormat(state)` helper centralises the `'mp3'` default so callers never read `state.audioFormat` directly.
- **Locator widened:** `findChapterAudio` probes `.mp3 → .m4a → .ogg` in that order (legacy-first so existing books behave identically). The probe loop returns the first hit; an `.mp3` next to an `.m4a` still wins (consistent with what would happen if a user toggles audioFormat mid-book and re-renders only some chapters).
- **Export gate:** `mp3-zip` now strictly requires `.mp3` chapters on disk (it tags via ID3v2 which doesn't travel in M4A/Ogg); mismatched chapters surface via the existing 409 missing-chapter banner.
- **Migration story:** zero. Existing state.json files don't carry `audioFormat`; the read seam interprets that as `'mp3'`, which is what the encoder, the file locator, and the generation path all do today anyway. A user opts in by editing the field via the export modal (next iteration) or directly via the `PUT /api/books/:bookId/state` `slice: 'state'` endpoint.
- **Reversibility:** dropping plan 72 means reverting `mp3.ts` dispatch, removing the codec-zip builders, and stripping `audioFormat` from the state allow-list — no on-disk migration needed because the default keeps existing chapters playable.

## Invariants to preserve

1. `bookStateAudioFormat(state)` returns `'mp3'` whenever `state.audioFormat` is absent, undefined, or any value outside the union (`server/src/workspace/scan.ts`).
2. `findChapterAudio` resolves to mp3 before m4a or ogg when multiple formats live in the same directory — `EXT_PROBE_ORDER` in `server/src/workspace/chapter-audio-file.ts:31-35`.
3. `encodePcmToAudio({ format: 'mp3' })` emits libmp3lame VBR V2 (`-q:a 2`). **Plan 109 deliberately changed the invocation** — MP3 output now goes to a seekable temp file (not `pipe:1`) with an explicit `-write_xing 1` so the Xing VBR header lands, so the buffer is no longer byte-identical to the pre-plan-72 output (it gains the Xing header frame; players otherwise misreport duration ~7×). The `-q:a 2` quality and the loudnorm output `-ar` pin (plan 71) are unchanged. `server/src/tts/mp3-spawn-args.test.ts` and `server/src/tts/mp3.test.ts` lock the current args + an ffprobe-duration regression — any change to `buildMp3FfmpegArgs` MUST keep them green. See [109-mp3-xing-vbr-header.md](archive/109-mp3-xing-vbr-header.md).
4. `hasLibFdkAac()` is idempotent and cached per-process; encoder dispatch must not spawn a probe on every call.
5. The `mp3-zip` export refuses non-mp3 chapters with the same `ExportIncompleteError` shape (missing-chapter slug list) the modal already renders.
6. `BookExportRequest.format` enum in `openapi.yaml` matches the `BookExportJob['format']` union in `server/src/routes/export.ts` and the `FormatId` union in `src/modals/export-audiobook.tsx`.

## Test plan

### Automated coverage

- `server/src/tts/aac.test.ts` — encodes synthetic 24 kHz PCM with `format: 'aac-m4a'`, asserts the `ftyp` box marker + a recognised major brand, then ffmpeg-decodes the buffer back to PCM as a round-trip smoke. Also exercises `hasLibFdkAac()`'s cached return value.
- `server/src/tts/opus.test.ts` — same shape for opus: asserts the `OggS` magic prefix and round-trips back to PCM.
- `server/src/tts/mp3.test.ts` — pre-existing MP3 regression untouched. Locks the libmp3lame default path against drift.
- `server/src/workspace/chapter-audio-file.test.ts` — multi-format probing: `.m4a` → m4a descriptor, `.ogg` → ogg descriptor, mp3 wins when multiple coexist.
- `server/src/workspace/book-state-audio-format.test.ts` — the `bookStateAudioFormat` defaulting helper: absent / undefined → mp3, present → reflected.
- `src/modals/export-audiobook.test.tsx` — extended with three plan-72 cases: all four toggle buttons render, `format: 'aac-m4a-zip'` propagates to `createBookExport`, `format: 'opus-ogg-zip'` propagates to `createBookExport`.
- Existing server tests stay green: `chapter-audio.test.ts`, `book-state.test.ts`, `export.test.ts`, `generation.test.ts` (default `'mp3'` round-trips identically).

### Manual acceptance walkthrough

Run with the real server + sidecar (`npm start`), `ANALYZER=local`, ffmpeg on PATH.

1. **Cold boot at `#/`.** Library lists existing books, all rendering with their pre-plan-72 mp3 audio. **Expected:** no UI change vs. main; the audioFormat field is invisible to the library card.
2. **Open an existing book → Listen.** Chapters play exactly as before (the `findChapterAudio` legacy-first probe order keeps the same mp3 files in place). **Expected:** zero playback regressions.
3. **Open the export modal from the Listen header pill** (no prefill). **Expected:** four toggle buttons visible — M4B, MP3.ZIP, AAC (M4A), Opus (Ogg).
4. **Click "AAC (M4A)" → Build download.** With an mp3-generated book, the request reaches the server; the `aac-m4a-zip` builder finds no `.m4a` chapters and returns `ExportIncompleteError` with every chapter slug. **Expected:** modal renders the missing-chapter banner with the full list.
5. **Override the book's `audioFormat` via the PUT `slice: 'state'` route to `'aac-m4a'`**, then regenerate the book from the Generate view. **Expected:** chapters land as `<slug>.m4a`; the Listen view still streams them via `audio.m4a`.
6. **Re-open the export modal, pick AAC (M4A), Build download.** **Expected:** zip download streams; opening the zip shows per-chapter `.m4a` files. iOS / VLC / Audiobookshelf all play the contents.
7. **Repeat steps 5-6 for `audioFormat: 'opus'`.** **Expected:** chapter files land as `.ogg`; the opus-ogg-zip export packages them.

Canonical end-to-end manuscript for full-pipeline regression: `server/src/__fixtures__/the-coalfall-commission.md` (do not commit — copyrighted).

## Out of scope

- **No per-chapter format override.** v1 is whole-book only; a user can't have chapter 1 in mp3 and chapter 2 in opus. The Listen-view stream of mixed-format chapters would force per-chapter `<audio src>` overrides we don't have today.
- **No format-converting export.** Picking `mp3-zip` against an `audioFormat: 'opus'` book returns 409 rather than re-encoding back to mp3. The user re-renders the book under the desired format, or picks the matching `*-zip`. A "transcode export" pass would be a separate plan.
- **Tagging for AAC/Opus exports.** `aac-m4a-zip` and `opus-ogg-zip` do NOT re-tag the chapter files (`applyId3v24Tags` is mp3-specific). M4B remains the single-file tagged export. Per-format tag support (iTunes atoms / Opus comment headers) is a future plan.
- **Clip export (`server/src/routes/clip.ts`).** Still emits `.mp3` regardless of source format (it uses `-c copy -f mp3` which fails on m4a/opus sources). Listed in the backlog for a follow-up.
- **`preserveExistingAsPrevious`** writes only `.previous.mp3`; preservation across format switches isn't wired. A book switching formats mid-flight loses A/B audition for any chapter where the format flips. The audition surface itself remains mp3-only for now.
- **Loudnorm (Could #1).** Lives on the parallel agent's branch (`feat/server-audio-loudnorm`); the encoder seam here doesn't interfere — loudnorm runs upstream of `encodePcmToAudio`.

## Ship notes

Shipped 2026-05-20 on branch `feat/server-audio-codec-aac-opus`. Closes "Could #2 — AAC/M4A or Opus output (swappable encoder)" from `docs/BACKLOG.md`. The encoder dispatch was already partially scaffolded by the refactor PR #71 (commit `b88b886`) — plan 72 widens the discriminator union and wires it through the rest of the pipeline.
