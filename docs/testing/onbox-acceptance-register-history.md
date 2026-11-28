# On-box acceptance register: change history

This is the register's change log up to 2026-11-28, moved out of [the register](onbox-acceptance-register.md) when it was cleaned up (#4883). It records how the owed count moved and what each discharge observed. Entries are newest first and verbatim, apart from the words "(since removed from the register)" added after some row IDs so the citation checker can tell they are history. The full text of every row as it stood before the cleanup is in git: `git show e296a706:docs/testing/onbox-acceptance-register.md`.

New changes are not logged here. A discharge records its outcome in the run sheet, the results folder or the issue, and the pull request carries the rest.

## Rows removed in the 2026-11-28 cleanup (#4883)

The first step of the cleanup took the owed count from 92 to 88. Each of these four rows was removed because its acceptance had already been run and recorded, but the row had been left in place. Nothing was removed on the strength of tests passing.

### A12, Device-pin resolution survives a respawn (#1870, #1857)

2026-09-08, on both cards, pinning Qwen to a card survived a forced supervisor respawn; `tts.qwen.codecDevice` placed the codec on the pinned card; and a codec pin on an absent card logged `QWEN_CODEC_DEVICE=… did not match any visible GPU` and left the codec on cpu. 2026-09-20 (#3296), the last bullet passed in an uncontended window: with the card enumeration order reversed (`CUDA_VISIBLE_DEVICES=1,0`), the raw UUID literal still landed on the RTX 5070 Ti with `validate=ok`, and the codec followed to the other card. Evidence: `onbox-2card-pinokio-batch-results/a12-enumeration-2026-09-20.md`.

### A33, Kokoro's silent-CPU-fallback alarm (#2647, #2643)

- 2026-08-27: a genuine fallback under a real missing-cuDNN gap carried `stale_reason: 'cpu_fallback'` in the `idx: -1` bucket; the forced kokoro-onnx API-drift branch reported no `stale_reason`; and a real unpinned `POST /synthesize` produced `cpu_fallback` (the #2643 real-generation path).
- 2026-09-23 (Castwright#3314): a deliberate VRAM-ledger CPU admission under contention showed no `stale_reason` while `devices.kokoro` read `cpu`; the idle positive control read `cuda` with `cuda_verified: true` and no `stale_reason`. The #2643 negative control (a box with no CUDA at all) was attempted by masking the device and measured as unreachable on this box, because the ORT build ignores the mask. Evidence: [`onbox-batch-results/a33.md`](onbox-batch-results/a33.md).

### D2, fs-61 zh/ja placeholder voices (#1600)

On 2026-09-24 the shipped bulk `POST /books/:id/cast/design` was run against both books (tier `qwen3-tts-1.7b`, persona engine `local` on `qwen38-cw-iq3-80k:latest`). zh `castwright__standalones__煤落的委托` and ja `castwright__standalones__コールフォールの依頼` each designed 13 of 13 characters with 0 failures. For all 26 voice ids the full triple (`.json` persona sidecar, `.pt` speaker embedding, `__master.wav` reference clip) exists under `castwright-workspace/voices/qwen/`, and each book's `cast.json` carries a non-empty `voiceStyle` and `overrideTtsVoices.qwen.name` for every character. 13 audition `.mp3` files per book sit in `server/audio/voices/`. Evidence: [`onbox-human-checkpoint-results/2026-09-24-d2-zhja-design-evidence.txt`](onbox-human-checkpoint-results/2026-09-24-d2-zhja-design-evidence.txt).

**Not claimed:** that each voice sounds right to a native zh or ja ear. The 26 auditions are the listen queue, tracked under [#1600](https://github.com/dudarenok-maker/Castwright/issues/1600) (open), which also tracks the missing zh/ja cover art.

### G2, The published release body comes from the committed file (#2137)

The v1.15.0 cut (tag pushed 2026-11-13, release workflow run `43375535330`, the first real tag after the fix) passed every observation. The "Resolve + guard release body" step succeeded and logged `[release-body] OK — wrote release/tag-notes.md from docs/release-notes-next.md (56404 bytes)`, so the file was the source. The published GitHub release body matches `git show v1.15.0:docs/release-notes-next.md` (56,404 bytes in the file; the release body differs only by one trailing blank line). The annotation checks ran in that step and it exited 0. Nothing is owed; the row can be removed.

For D2, the native-ear listen to the zh and ja voices stays tracked on issue #1600, which is open. For A33, the one check that never passed (a machine with no CUDA device at all) was attempted and measured as unreachable on the owner's box. That check was carried as Blocked row BLK107 (removed from the register 2026-11-28 by owner ruling, #4953), which the owner waived the same day (entry below).

## Rows waived by the owner on 2026-11-28 (#4883)

The owner reviewed these 13 entries during the cleanup and ruled each one not worth carrying. None has a complete recorded pass. They are listed so the ruling can be revisited: the full text of each row is in git at the commit named at the top of this file. With these removed the owed count went from 88 to 77. Row E115 was discharged separately on the same day (#4738, entry below), which makes 76, and row E112 (discharged, removed from the register) by the Gemini re-run (#4728, entry below), which makes 75. A 14th entry, BLK107 (removed from the register 2026-11-28 by owner ruling, #4953), was waived later the same day (#4953); it was a Blocked row, so the owed count did not move.

**The main checks passed and what is left cannot be produced**

- **A26, catastrophic word-error-rate override on a real Coqui language collapse (#2055).** In 48 live trials the override never fired, and the plain word-error-rate branch caught all three real collapses. The false-positive control is resolved (#3118, closed). Whether to retune `minAvgLogprob` is a tuning question, not an acceptance debt.
- **B103, abort and drain on a local Ollama analyzer (#3435).** Abort, drain order, model release and the absence of `drain deadline exceeded` passed for Pause and halt on 2026-11-26. The `draining:true` refusal is a window of about 1 ms against a local model and is covered by `server/src/routes/analysis.refuse-while-main.test.ts`. A file-level diff of the cache and edits files after the drained line was never done.
- **B105, Ollama structured-output modes on a real model (#3084).** The `json`, `off` and default modes passed on 2026-11-26. The one item left needs an Ollama build that rejects a mode; 0.40.5 accepts all three, and the rejection mapping was proven with a simulated 400.

**Cannot practically be run**

- **A15, a loudness measurement failure renders as untrusted (plan 274).** Never run. Plan 274 says unit test T6 covers it and that the real failure is hard to force; the row called itself opportunistic.
- **A18, cloned-voice derive on Coqui without torchcodec (#1967).** Items 1, 3 and 4 passed. The audible half of item 2 needs a shared-FFmpeg box that does not exist, and the replacement decoder measured bit-identical (maximum difference 0.0) against the original.
- **A19, a stranded VRAM pool is reclaimed on the admission-failure path (#1976).** Six measurements on four days, the last on 2026-11-26, never produced a stranded pool, so the reclaim was never watched. The two guard checks (no reclaim mid-render, once per 30 s) were not tried with an external VRAM filler.

**Tooling and unsubstantiated suspicions**

- **G1, the quarantine-lane health report (ops-32, #1864).** A non-gating CI report. Its scheduled runs succeeded through 2026-11-23. The last debt needs a real quarantined flaky test, and `docs/testing/flaky-register.md` has none.
- **UNC101, fs-38 Wave 1 designed-voice authoring (PR #1800).** Listed as unconfirmed since the register was first built; no owed criteria were ever found. Closed bugs #1802, #1833 and #1836 show the feature in live use.
- **UNC102, Ollama concurrency (K greater than 1) real-VRAM validation (PR #1707).** Listed as unconfirmed; no written criteria were ever found, and the UI half is row B1's K=4 step.

**Blocked on hardware or a trigger the owner does not have**

- **A3, srv-57 multi-GPU wave 2 auto-revert.** The trip and the `unrevertable` outcome ran for real on 2026-09-20. The live `reverted` decision cannot be induced on the two-card box.
- **C3, a deterministic stage-2 failure clears when the span is halved (#2304).** The trigger was seen on `qwen36-cw-iq4-32k`, which is no longer on the box; the replacement model did not reproduce it on 2026-09-05.
- **E106, verify time budgets forward Ctrl+C and SIGTERM on POSIX (#3249).** Never run. Needs a Mac or Linux machine.
- **E109, `npm run stop:prod` on a real POSIX box (PR #3404).** Never run. Needs a Mac or Linux machine; the failure path is covered by a stub-process unit test.
- **BLK107 (removed from the register 2026-11-28 by owner ruling, #4953), Kokoro's silent-CPU-fallback alarm stays quiet on a machine with no CUDA device (#2643).** The no-CUDA negative control left over from row A33 (since removed from the register). Never run: no CUDA-less machine exists. Waived by the owner on 2026-11-28 (#4953).
## Change log

> **Previous change: 2026-11-28 (#4728), 91 → 90.** Row **E112** (since removed from the register) (Gemini `schema` mode on a real key, #3084 PR 3b) DISCHARGED and removed by the on-box Gemini re-run (#4728). All three observations are recorded for both models. `gemini-3.5-flash-lite` (2026-11-26, #4701, `main` at 035ff80a): the schema was accepted with no HTTP 400, the "schema adapter dropped" list matched the committed `gemini / stage1Chapter` snapshot (6 keys), and the first reply conformed (0 validation retries). `gemma-4-31b-it` (2026-11-28, #4731, branch at 68849e3a, docs-only over `main` ddf1b3f0): accepted with no HTTP 400 on any of 3 request attempts, the same 6-key list in the same order, and the one reply returned passed validation (0 validation retries), on the third transport attempt after two `503 UNAVAILABLE`. The row's criteria are "record"; this does not by itself move Gemini's structured-output default. Evidence: `docs/testing/onbox-gemini-rerun-results/E112/` and `docs/testing/onbox-batch-2-results/E112/`. **E111**, **E114** and **B101** stay owed with their KEEP verdicts. Group E 20 → 19. `next-id` markers untouched (allocate-once).
>
> **Previous change: 2026-11-28 (#4738), 92 → 91.** Row **E115** (Gemini config payload, #3084 wave 5b) DISCHARGED and removed; it owed only the rejected-value bullet (#4718). **2026-11-28 — #4718 fix on-box (`fix/server-4718-gemini-400-classify`), claude/claude:** Rejected value re-run — **PASS** on `f36e7873`, real Gemini key, `gemini-3.5-flash-lite`, the Coalfall fixture (3 chapters). This worktree's dev server on port 8130 (the worktree's own 8090 was held by another process), a throwaway `USER_SETTINGS_FILE`, TTS sidecar auto-start off; stdout was redirected to `logs/server.log`. Gemini answered the 400 on the first attempt. All three `chapter-failed` frames read `"code":"analyzer-request-rejected"` with the value `"[redacted]"`. `Select-String -Path logs\server.log -SimpleMatch 'castwright-onbox-probe-value'` counts 0 (also 0 in `logs/server.err.log`; each file has 6 `[redacted]` lines). On screen, the three Analysing failure cards end `"[redacted]"` and the probe value is not in the page HTML (the first-run Setup wizard opened first, so the route was opened by hash). Evidence: `docs/testing/onbox-4718-results/E115/`. The other three bullets passed on 2026-11-26 on `main` at `035ff80a` (#4700, `docs/testing/onbox-batch-2-results/E115/`; the output-cap label was read from the catalog API, not the browser) and were not re-run. **Row verdict: DISCHARGE** Group E 21 → 20. `next-id` markers untouched (allocate-once).
>
> **Previous change: 2026-11-28 (#898, PR B), 91 → 92.** Row **E120** (companion token scope end to end on a real phone: the nine allowed endpoints, the legacy no-scope record reaching the pairing screen, one re-pair, and the browser-pairing negative control) added. Group E 20 → 21. `next-id` bumped E120 → E121 in the same change (`origin/main`'s `next-id` for group E was E120; the row was minted as E119 and renumbered at merge because #4650 took E119). Row is owed; not run here.
>
> **Previous change: 2026-11-27 (#4650), 90 → 91.** Row **E119** (the companion's idle save never wins a resume sync, and a save after an out-of-band stop such as a headset unplug is stamped with the time audio stopped) added. Group E 19 → 20. `next-id` bumped E119 → E120 in the same change. Row is owed; not run here.
>
> **Previous change: 2026-11-26 (#4699, #4715), 92 → 90.** Rows **A126** and **B107** DISCHARGED and removed by on-box batch 2 (#4699). **A126** (a cold model load learns its own weights, a warm op learns nothing): all five bullets passed on a real RTX 4070 Laptop 8 GB with a real Qwen sidecar (run 2026-11-27, child #4710): the cold-load counter rose by exactly 1 per cold load to 5 with `learned_mb` 1745 (93% of the first load's `nvidia-smi` rise of 1873 MiB); warm 0.6B and 1.7B-Base renders (`POST /synthesize` only, 0 `/synthesize-batch`) recorded nothing; a Qwen cold load beside resident Coqui did not absorb Coqui's 2097 MiB (`learned_mb` unchanged); a cold reload after a long warm run fitted (rise 1796 MiB against 1745 + reserve, 0 OOM, 0 503); the mint key learned only from cold mints (5 samples, `learned_mb` 5468). Evidence: `docs/testing/onbox-batch-2-results/A126/`. **B107** (Ollama reasoning levels and Test attribution): all four bullets passed against a real Ollama 0.40.5 daemon (run 2026-11-26, child #4705): the non-thinking `llama3.1:8b` recorded `on`/`low`/`medium`/`high` rejected and `off`/`model-default` accepted; the thinking `qwen3.5:4b` recorded `low` accepted and offered only in its own row; a run with a rejected level fails before the first chapter naming the level and the Test date; a re-created tag's `scope:configured` Test dropped the earlier levels (the build change was made by re-creating a throwaway tag, not a remote re-pull). One copy observation is recorded in the batch-2 evidence and is not owed: a rejected level that is also not offered fails with copy that names the level but not the Test date. Evidence: `docs/testing/onbox-batch-2-results/B107/`. Group A 55 → 54, group B 11 → 10; the 13 other batch-2 rows stay owed with their KEEP verdicts unchanged. `next-id` markers untouched (allocate-once).
>
> **Previous change: 2026-11-25 (#3268), owed count unchanged.** Row **E5** (the touch-flash smoke check) amended: the voice-library drag icon is struck from its target list, because #3268 resolved to remove the control (`VoiceCard`'s drag-icon branch is deleted, including the Voices page's use of it). The row's remaining owed targets are the continue-listening play badge and the "Add book" tile; the 09-19 note's premise is corrected in a dated note on the row. The row stays owed; no row added or removed; `next-id` unchanged.
>
> **Previous change: 2026-11-26 (#3270, #4673), 93 → 92.** Row **H2** (the lexical-richness floor on a real Han book) DISCHARGED and removed. Outcome: the fixture `server/src/__fixtures__/hongloumeng-1-21.zh.md` (an excerpt: chapters 1-21 of the book's 120, 《紅樓夢》, public domain, from Chinese Wikisource, #4671) ran through `detectManuscriptLanguageFromChapters` in the Group H describe block of `server/src/tts/detect-language.test.ts` (#4672, commit 15892aaf, run 2026-11-25) and gave `{ language: 'zh', supported: true, fallback: false }`, the same reversed. gate figures **N = 112,304** tokens and **V = 3,336** distinct (after `dedupeProseUnits` and digit-token removal; no chapter reaches the 20,000-character cap), **R = 9.9547** (`guiraudR`, = 3,336 / sqrt(112,304)); the raw pre-dedupe Han counts are 115,515 characters and 3,348 distinct, against `LEXICAL_RICHNESS_FLOOR` (3): the uncapped gate clears the floor on this excerpt. The excerpt is 112k gate tokens, below the removed row's own N ≈ 400,000 concern, so what closes the row at book scale is a bound, not the measurement: `dedupeProseUnits` keeps the token set a superset as chapters are added, so V can only grow and any longer sample of this book keeps R ≥ 3,336 / √N, which stays above the floor of 3 for every N below about 1.24M tokens; the whole 120-chapter book projects to about 640k tokens, where the bound is R ≥ 4.2. No length-correction follow-up is owed. The test asserts 21 chapters, a raw Han count > 105,000, a raw distinct count > 3,000, and R above the floor. Group H 2 → 1; the group's heading, intro and glance description now describe H1 alone (H1's own text is unchanged). `next-id` for group H stays H101 (IDs are allocate-once; H2 is simply gone). The automated test is the acceptance because H2 needs no GPU, sidecar or analyzer.
>
> **Previous change: 2026-11-24 (#898, PR A), 92 → 93.** Row **E118** (the companion handshake 401 opens the pairing screen on a phone with a fully downloaded library, and an off-Wi-Fi phone does not) added. Group E 18 → 19. `next-id` bumped E118 → E119 in the same change (`origin/main`'s `next-id` for group E was also E118). Row is owed; not run here.
>
> **Previous change: 2026-11-21 (#1393), 91 → 92.** Row **A134** (the generation path keeps only the Qwen tiers a book's unfinished chapters will use: a pure-1.7B run drops a silent 0.6B character's tier, a mixed-tier book unloads neither early, and the missing-artifact co-residency outcome is recorded) added. Group A 54 → 55. `next-id` bumped A134 → A135 in the same change (relative to `main`, whose `next-id` for group A is A134 after #4533 and #4535). Row is owed; not run here.
>
> **Previous change: 2026-11-21 (#4443, PR #4535), 90 → 91.** Row **E117** (the Windows Node loopback-crash guard: the refusal on an affected Node, the Pinokio "run Update again" message, two-Update convergence, and the in-app upgrade's held-back card plus `logs/upgrade-restart.log`) added. Group E 17 → 18. `next-id` bumped E117 → E118 in the same change. Row **E1** amended: the Pinokio pin is now `nodejs>=24.16.0,<25` and the expected Node after the second Update is 24.16.0 or newer below 25. Row is owed; not run here.
>
> **Previous change: 2026-11-21 (#4533), 89 → 90.** Row **A133** (the capacity-denied eviction lever keeps the Qwen models another live voice design or variant mint is using: a Coqui preview denied capacity during a mint leaves the 1.7B, and during a design leaves the 0.6B and VoiceDesign) added. Group A 53 → 54. `next-id` bumped A133 → A134 in the same change. Row is owed; not run here.
>
> **Previous change: 2026-11-20 (#4445), 88 → 89.** Row **A132** (the generation path's Qwen tier reconciles skip their eviction while other GPU work is active: a repair on a Quality book keeps its 1.7B while another book's render finishes a chapter) added. Group A 52 → 53. `next-id` bumped A132 → A133 in the same change. Row is owed; not run here.
>
> **Previous change: 2026-11-19 (#4456), 87 → 88.** Row **A131** (a GPU Whisper or Qwen on the second card is fit-checked and evicted against that card) added. Group A 51 → 52. `next-id` bumped A131 → A132 in the same change. Row is owed; not run here.
>
> **Previous change: 2026-11-18 (#4237), 86 → 87.** Row **A130** (a mint is admitted beside its own resident 0.6B audition base, without waiting for or evicting the resident models) added. Group A 50 → 51. `next-id` bumped A130 → A131 in the same change. Row is owed; not run here.
>
> **Previous change: 2026-11-18 (#4164), 85 → 86.** Row **A129** (the admission ladder frees the op's own card on a two-GPU box, not the roomiest one) added. Group A 49 → 50. `next-id` bumped A129 → A130 in the same change. Row is owed; not run here.
>
> **Previous change: 2026-11-18 (#4164), 85 → 86.** Row **A129** (the admission ladder frees the op's own card on a two-GPU box, not the roomiest one) added. Group A 49 → 50. `next-id` bumped A129 → A130 in the same change. Row is owed; not run here.
>
> **Previous change: 2026-11-17 (#4242), 83 → 84.** Row **A128** (EPUB and MOBI books read the same through the parse worker as in-process, at extractor version 1 and 2: parity over the operator's real library) added. Group A 48 → 49. `next-id` bumped A128 → A129 in the same change. Row is owed; not run here.
>
> **Previous change: 2026-11-17 (#4217), 82 → 83.** Row **A127** (an existing book keeps its old extraction, byte for byte; a new import gets the paragraph-closer fix) added. Group A 47 → 48. `next-id` bumped A127 → A128 in the same change. Row is owed; not run here.
>
> **Previous change: 2026-11-15 (#4102), 81 → 82.** Row **A125** (a mint, a design, a GPU ASR op and a GPU speaker op keep their own resident model through their own admission) added. Group A 46 → 47. `next-id` stays A127 (A125 was reserved for this row). Row is owed; not run here.
>
> **Previous change: 2026-11-13 (#4163), 80 → 81.** Row **A126** (since removed from the register) (a cold model load learns its own weights, a warm op learns nothing: the per-op VRAM footprint fix) added. Group A 45 → 46. `next-id` bumped A125 → A127 in the same change; A125 is reserved for #4102's row. Row is owed; not run here.
>
> **Previous change: 2026-11-13 (#4054), 79 → 80.** Row **A124** (the next silent server death leaves its evidence: the boot line under each launcher, then the exit-code line, the server log tail and any diagnostic report posted on #4054) added. Group A 44 → 45. `next-id` bumped A124 → A125 in the same change. Row is owed; not run here.

> **Earlier change: 2026-11-12 (#4031, PR #4103 pass 5b), owed count unchanged.** Row **B109**
> amended (plan 291 R57): the drawer's merge and downgrade are disabled mid-run, so the
> refused-merge observation now comes from a second device or a tab opened before the run. No
> row added or removed; `next-id` unchanged. Merged with `main`'s row **A123** (#4054): the
> two rows' counts add, 77 → 79.
>
> **Previous change: 2026-11-12 (#4054), 77 → 78.** Row **A123** (the sidecar exits when the server dies and logs the server's exit code: `taskkill /F`, `Stop-Process`, console Ctrl+C) added. Group A 43 → 44. `next-id` bumped A123 → A124 in the same change. Row is owed; not run here.
>
> **Previous change: 2026-11-12 (#4031, PR #4103 pass 5), owed count unchanged.** Row **B109**
> amended (plan 291 R55): a merge or an accepted suggested merge is refused while the run is
> going, so the row now observes that refusal; designing a voice stays the live mid-run write.
> No row added or removed; `next-id` unchanged.
>
> **Previous change: 2026-11-12 (#4079, PR #4093), owed count unchanged.** Row **A122** gets a run flag for the 1.7B-tier lifecycle fix (chapter 2 completes at Quality, the lease defers the 1.7B-Base idle watchdog, a Standard render takes none); the refused-own-line Kokoro free was not observed. The row stays owed; no row added or removed; `next-id` unchanged.
>
> **Previous change: 2026-11-11 (#4031, plan 291), 77 → 78.** Row **B109** (re-analysis only adds
> to a real voiced cast, the cast is read-only with a banner until it reloads, Start fresh keeps
> every decision, a stop and resume match a straight run) added. Group B 9 → 10. `next-id`
> bumped B109 → B110 in the same change. Row is owed; not run here.
>
> **Previous change: 2026-11-11 (#4066, #4037, #4075, PR #4076), owed count unchanged.** Rows **A120** and **A122** run on the box and recorded in new flags (A122 on 2026-11-10 through the HTTP API, A120 run 2 on 2026-11-10 through the browser and the API); both rows stay owed. A122 bullet 7 is amended to state the accepted early-eviction residual (#4075), and A120 steps 6, 13 and 17 are reworded to match what the run showed. No row added or removed; `next-id` unchanged.
>
> **Previous change: 2026-11-10 (#4066), 76 → 77.** Row **A122** (a voice design or a Quality render on
> an 8 GB card frees the resident standard Qwen and Kokoro first; the capacity error no longer says
> "Turn off Preload Kokoro" with preload off) added. Group A 42 → 43. `next-id` bumped A122 → A123 in
> the same change (ID A121 was retired unused by PR #4052). Row is owed; not run here.
>
> **Previous change: 2026-11-10 (#4037, #4062, PR #4052), owed count unchanged.** ID **A121** retired unused: PR #4052 allocated it for the mint copying a legacy voice's emotion variants, but PR #4061 shipped that copy first and A120 step 20 already owes its on-box check, so the row was dropped before it reached `main` or the live view. `next-id` bumped A121 → A122 so the ID is never re-minted. No row added or removed.
>
> **Previous change: 2026-11-09 (#4037, #4040), owed count unchanged.** Row **A120** steps 13, 20 and 21 run on the box and recorded in a new flag; step 13's link cycle was made by hand, and step 13's text is amended (the row must not be locked or tuned, and a hand link through `POST /cast/link-prior` is stated as the alternative setup). The row stays owed. No row added or removed; `next-id` unchanged.
>
> **Previous change: 2026-11-08 (#4037, #4040, PR #4061), owed count unchanged.** Row **A120** amended:
> step 13 now observes an emotion variant going stale when its voice's base is redesigned
> (`rev`/`baseRev`), new step 20 covers the legacy variant copy at the series mint plus the
> same staleness across books, and new step 21 covers the sidecar rendering from a base replaced
> on disk behind its back. No row added or removed; `next-id` unchanged.
>
> **Previous change: 2026-11-05 (#3992, PR #4007), 75 → 76.** Row **A120** ("Don't reuse" moves a
> declined series character onto a voice of its own at once, with every later book whose link
> chain leads down to it; redesigning it afterwards never touches the earlier book's voice and is never refused; the
> decline survives re-analysis) added. Group A 41 → 42. `next-id` bumped A120 → A121 in the same
> change. Row is owed; not run here. Review pass 10 (#4028) added steps 13-15 to it (a link cycle
> through the declined book, a legacy series' variants, a decline during a running design); the
> count is unchanged. Review pass 11 added steps 16-19 (a legacy Design and compare then Cancel, a
> design before Confirm, a link made during a design, nothing staged left behind); the count is
> unchanged.
>
> **Prior change: 2026-11-01 (#3713, PR #4004), 74 → 75.** Row **E116** (the duplicate-bookId
> startup sweep on a real library: the twin with the work keeps the id, the loser is re-minted,
> both books open, the repair banner shows once, a second start changes nothing) added. Group
> E 16 → 17. `next-id` bumped E116 → E117 in the same change. Row is owed; not run here.
>
> **Prior change: 2026-10-31 (#3920, PR #3934), 73 → 74.** Row **B108** (re-analysis keeps a
> locked or tuned character's voice whole, and no fresh row inherits a link it was not joined
> to) added. Group B 8 → 9. `next-id` bumped B108 → B109 in the same change. Row is owed; not
> run here.
>
> **Prior change: 2026-10-30 (#3084 wave 5b, PR 5b), 71 → 73.** Rows **A119**
> (custom payload on real servers) and **E115** (Gemini config payload) added from #3084 PR 5b's
> run sheet (`3084-openai-analyzer-onbox-acceptance.md` §14–§15). Group A 40 → 41, E 15 → 16.
> `next-id` bumped A119 → A120 and E115 → E116 in the same change. Rows are owed; not run here.
>
> **Prior change: 2026-10-27 (#3084 wave 5a, PR 5a), 68 → 71.** Rows **A118**
> (endpoint reasoning styles take effect on llama-swap), **B107** (Ollama reasoning levels and
> Test attribution) and **E114** (Gemini reasoning levels take effect) added from #3084 PR 5a's
> run sheet (`3084-openai-analyzer-onbox-acceptance.md` §11–§13). Group A 39 → 40, B 7 → 8,
> E 14 → 15. `next-id` bumped A118 → A119, B107 → B108 and E114 → E115 in the same change.
> Rows are owed; not run here.
>
> **Prior change: 2026-10-24 (#3084 W4, #3777), 68 → 68.** Row **A109** rewritten
> against the merged wave 4: the run must set Persona generation engine to the same-card
> endpoint's model, and observes the persona requests reaching the endpoint before
> VoiceDesign loads, W3d's eviction unloading it, and the "Pause audio generation to design
> voices?" guard's **Pause and design** acknowledging the render's abort before the first
> persona request (an in-flight sidecar synth is not awaited, so criterion 3 records whether
> its tail overlapped; criteria 1, 3 and 5 reworded to say so). Criterion 3 now runs on its own
> fresh book whose characters have no voice description, because the book that steps 1-2
> design has none left to prompt for. The "cannot be run until wave 4 merges" sentence is dropped. Run sheet §10 added. No row added or removed;
> `next-id` unchanged. Row is owed; not run here.
>
> **Prior change: 2026-10-17 (#3084 W3d, task 3d.10), 65 → 68.** Rows **A115**
> (long silent prefill completes on an endpoint), **A116** (same-card eviction of
> an endpoint for a Qwen load) and **A117** (fallback to a smaller context leaves
> room to answer) added, and row **A113** extended with the real-chapter
> structured-output checks, from #3084 PR 3d's run sheet
> (`3084-openai-analyzer-onbox-acceptance.md` §6–§9). Group A 36 → 39. `next-id`
> bumped A115 → A118 in the same change. Rows are owed; not run here.
>
> **Prior change: 2026-10-17 (plan 286, #3400/#3397), 64 → 65.** Added **A114** —
> the revisions server-ownership cutover: accept/reject/dismiss move to
> per-op server routes, pending comes only from the server, and every render
> records or drops a chapter's A/B state itself, closing the #3397 gap A9's
> body documented (a take finishing while you were away from its book coming
> back stuck or without an A/B prompt). A9's own "known gap (#3397)" sentences
> now point here instead of restating the gap as open. Group A 35 → 36.
> `next-id` bumped A114 → A115 in the same change.
>
> **Prior change: 2026-10-16 (#3524), 64 → 64.** Row **A112**'s text corrected, no
> row added or removed and the owed count unchanged: the audition-voice
> precondition now says `scoreBook` takes it from a chapter rendered in the
> character's current cast voice (not the first chapter in book order), and
> the closing "Known limit" is replaced — an in-book centroid recorded from a
> voice the character no longer has is now dropped too (a legacy in-book row
> with no recorded voice is still kept). A character reassigned but not yet
> re-rendered now gets a marker row from the scoring pass (it leaves the QA
> card's "pending" state), and the "current voice" engine is the engine actually rendered (the
> character's own engine, else the scoring run's model key — only for a
> character that run rendered lines for — else the engine stamped on its most
> recently rendered lines). The Reassign step now says not to
> run Resume scoring before the repair (a scoring pass rewrites the character's
> rows `inconclusive`, leaving nothing to observe) and checks the marker row as a
> separate step afterwards. Behaviour proven by mocked unit
> tests; A112 still owns the real-ECAPA hardware check.
>
> **Prior change: 2026-10-16 (#3587), 64 → 64.** Allocate-once IDs assigned to the
> Blocked rows (**BLK101**–**BLK106**) and the Unconfirmed bullets (**UNC101**–**UNC102**),
> with a `next-id` marker under each section heading (BLK107, UNC103). IDs allocated
> once (#3587); no row added or removed. Owed count unchanged at 64; Blocked stays 6,
> Unconfirmed stays 2.
>
> **Prior change: 2026-10-10 (#3084 W3c, PR 3c), 63 → 64.** Row **A113** (live
> structured output — Test action records match real model behaviour) added
> from #3084 PR 3c's run sheet (`3084-openai-analyzer-onbox-acceptance.md`
> § "Live structured output"). Group A 34 → 35. `next-id` bumped A113 → A114
> in the same change. Row is owed; not run here.
>
> **Prior change: 2026-10-09 (#3440), 62 → 63.** Row **E113** added — the real-book
> line-count and Fix-audio check for the drifted-attribution-id fix, owed because
> unit/integration/e2e coverage all run in mock mode and nobody has yet confirmed the
> real Playing with Fire book against it. Group E `next-id` marker bumped E113 → E114.
>
> **Prior change: 2026-10-08 (#3435, plan 287), 61 → 62.** Row **B106** (the
> background emotion re-run yields to and is aborted by real work on a real
> analyzer) added from plan 287's "On-box acceptance owed" item 3. Group B
> 6 → 7. `next-id` bumped B106 → B107 in the same change. Owed; not run here.
>
> **Prior change: 2026-10-06 (#3084 wave 3b, PR 3b), 59 → 61 on this branch (57 → 59 on `main`).** Rows **B105** (since removed from the register)
> (Ollama `format` modes on a real model: `json`, then `off`, against `schema`)
> and **E112** (Gemini `schema` mode, `responseJsonSchema` accepted or rejected
> on a real key) added from #3084 PR 3b's run sheet
> (`3084-openai-analyzer-onbox-acceptance.md` §4–§5). Group B `next-id` marker
> bumped by one, Group E by one. Both rows are owed; neither was run here.
>
> **Prior change: 2026-10-04 (#3435, plan 287), 57 → 59.** Rows **B103** (since removed from the register) (abort
> and drain on a local Ollama analyzer: a stopped main run releases the model
> before a chapter Retry starts) and **B104** (a Resume on a cast-confirmed book
> keeps every designed voice) added from plan 287's "On-box acceptance owed".
> Group B 3 → 5. `next-id` bumped B103 → B105 in the same change.
>
> **Prior change: 2026-10-03 (#3414), 56 → 57.** Added **A112** — the
> qa-repair centroid filter now drops an audition centroid whose recorded
> voice differs from the character's CURRENT cast voice (rather than keying
> off the chapter's last-render snapshot), so an acoustic-only flagged line
> lands in `stillSuspect` without being re-rendered instead of being judged
> against the old voice (a line also flagged by signal QA/ASR is still
> re-rendered and can be accepted on signal QA alone); in-book rows are
> unchanged (#3517); the regression suite (#3449, #3460) covers the logic branch
> against a mocked embedder, but nothing has yet proven the repair's
> accept/reject decision against a real sidecar's ECAPA embedding on real
> hardware. Group A 33 → 34. `next-id` bumped A112 → A113 in the same
> change.
>
>
> **Prior change: 2026-09-27 (#3084 wave 2b), 53 → 56.** Rows **B102** (capacity
> recalibration — the measurement owed before any capacity default changes),
> **E110** (Gemini thinking-window timing on real chapters — a measurement
> that gates nothing) and **E111** (a thinking Gemini model on a 20,000-
> character chapter at Auto output, and Gemma's empty-`MAX_TOKENS` split)
> added from #3084 wave 2's run sheet
> (`3084-openai-analyzer-onbox-acceptance.md` §1–§3). Group B `next-id`
> marker bumped by one, Group E by two.

> **Prior change: 2026-09-25, E108/E109/A111 ADDED** (#3403, #3406, PR
> [#3404](https://github.com/dudarenok-maker/Castwright/pull/3404)): three
> rows this same PR owes. **E108** carries forward E104's own unproven
> bullet 3 (the push-path `KILLED` print) against the fix for
> [#3403](https://github.com/dudarenok-maker/Castwright/issues/3403) — a
> `taskkill /T` nonzero exit no longer means the kill failed by itself, only
> a re-checked whole-tree liveness probe does. **E109** is the POSIX
> `stop:prod` async-shutdown grace period the same PR's review pass 2 found
> and fixed (no issue of its own — found and fixed in the same round).
> **A111** is the real-installed-release-zip row [#3406](https://github.com/dudarenok-maker/Castwright/issues/3406)
> owes: the manifest omission that left Windows sleep prevention inert on
> the released zip (and would have crashed `stop:prod` on the next one), closed
> by the same PR but unprovable without a packaged release directory this box
> doesn't have.
> 50 → 53 owed, Group A 32 → 33, Group E 8 → 10. `next-id` bumped E108 →
> E110 and A111 → A112 in the same change.
>
> **Prior change: 2026-09-25, A17/A32/A107/E103/E104 DISCHARGED and removed;
> A20/A105 restored, narrowed (owner decision)** (#3294, PR
> [#3402](https://github.com/dudarenok-maker/Castwright/pull/3402); the
> on-box runs themselves happened under PR
> [#3399](https://github.com/dudarenok-maker/Castwright/pull/3399), which
> recorded the outcomes inside each row's own body — all seven runs were
> agent-lane dispatches on the repo owner's box (`cline-qwen-cloud` where the
> row names a lane; A17's own note doesn't name one), commits authored as
> `dudarenok-maker`). An earlier pass of this PR (#3402, commit `6e655b77`
> onward) removed all seven rows, including A20 and A105; a review of
> PR #3402 found both still carry an unmet bullet in their own recorded text,
> and the repo owner decided **A20 and A105 stay in the register, narrowed to
> their one owed bullet each** — only the other five discharge.
> **Owner confirmation, 2026-09-25 (repo owner, `dudarenok-maker`):** the
> owner confirmed the A17 and A32 discharges, kept A20 and A105 owed
> (narrowed), and moved E104's bullet 3 (the push-path `KILLED` print) to a
> new row that PR [#3404](https://github.com/dudarenok-maker/Castwright/pull/3404)
> adds — see E104 below.
>
> **A17** (`/health` through a contended eviction on the default Qwen path,
> #1919, by whom not named in the row): the exact three-way race (VoiceDesign
> resident + a Base forward in flight + a concurrent second admission) was
> hit cleanly on 2026-09-20, with zero OOM and `/health`'s worst
> inter-response gap at 258.7 ms, well inside the ~500 ms target — all four
> row items met. **Caveat kept, not dropped:** the second admission's holder
> was driven via `POST /qwen/clone-voice` (an ungated 1.7B-Base forward
> holding the same `_synth_lock`), not the row's literal "start a Qwen
> chapter render" step — chosen because the app-level chapter-render variant
> had twice OOM'd (`vram-spill`) this 8 GB card in the 2026-09-06 attempt
> before the race could be measured; the row's own evidence says outright
> the app-level variant still doesn't fit this card mid-render, and that
> observation is left standing for A10, not re-attempted here. Evidence:
> `docs/testing/onbox-mechanical-batch1-results/a17-clean-retry-2026-09-20.md`.
>
> **A32** (named-entity decode reaches the TTS engine on a real EPUB, #2310,
> `cline-qwen-cloud`): the owed audio-level confirmation of the secondary
> (body-line) bullet completed 2026-09-23 — a decoded dash-opened line
> synthesized to a character-exact ASR transcript with a measurable prosodic
> pause, not leading silence — so both bullets now stand confirmed at text
> and audio level. **Caveat kept:** the bullet's "manuscript view shows real
> glyphs" clause was not observed in the UI; it was inferred from the
> `candidate.sourceText` field carrying the correctly decoded characters.
> Evidence: `docs/testing/onbox-batch-results/a32.md`.
>
> **A107** (`/load`'s Kokoro cold-load bypassed the VD/Kokoro arbiter,
> #3086/#3101, `cline-qwen-cloud`, issue #3309): the original repro — a raw
> cold Kokoro `/load` racing a real resident VoiceDesign forward on a shared
> device — was re-driven 2026-09-22 through the shipped guard and the bypass
> did not reproduce; the load was held for 43.3 s until the design released
> and then ran within ~1 s, matching the unit-level proof on real hardware.
> **Caveat kept:** this box has no DirectML profile (CUDA `onnxruntime-gpu`
> only), so `_directml_selftest_or_fallback`'s one-shot forward — the row's
> stated prerequisite — never ran; the row's own text judges the gate under
> test EP-agnostic and the discharge stands on that basis. Evidence: no
> separate evidence file; the row's last text is the register's A107
> section at `origin/main` `a8b0fcc6`, plus
> [#3309](https://github.com/dudarenok-maker/Castwright/issues/3309).
>
> **E103** (`wt-gc.mjs --prune` real junction-first teardown, #3051,
> `cline-qwen-cloud`, issue #3321): driven in full on-box 2026-09-24 against
> a real throwaway worktree with all four junctions — the one failure mode
> that matters (junctions silently skipped, `git worktree remove` recursing
> into the primary checkout's real trees) is ruled out with byte-for-byte
> child-list SHA-256 hashes matching before/after. Evidence: not durable —
> `e103-test.log`, `e103-report-{default,nogh,locked}.txt`,
> `e103-prune-{locked,final}.txt` under
> `%TEMP%\open-engine-scratch\cline-qwen-cloud-3321-20260924-085933\` on the
> box the run happened on; once this row is gone, git history (this note,
> and #3321) is the only durable record.
>
> **E104** (ops-71 stale-battery reaper `Win32_Process` classification
> against real processes, #3047, `cline-qwen-cloud`, issue #3322): driven in
> full on-box 2026-09-24 against three live fixture process trees plus one
> organic orphan the census found itself — all five observed behaviours
> (report-only census, stalled-rate detection, orphan kill via
> `npm run doctor -- --kill`, namer-only survival, push-cost + census-record
> accumulation) confirmed on real `Win32_Process` output, except bullet 3's
> push-path print (below). Evidence: not durable — `census-t0.txt`,
> `census-t1.txt`, `doctor-kill.txt`, `timeline.txt` under
> `%TEMP%\open-engine-scratch\cline-qwen-cloud-3322-20260924-093037\` on the
> box the run happened on; once this row is gone, git history (this note,
> and #3322) is the only durable record. **Bullet 3's push-path half was
> NOT observed as specified.** The criterion asks that, when the pre-push
> census is what reaps an orphan, `git push` prints
> `reap-stale-batteries: KILLED stale battery pid=… :: <command line>`.
> Both real pushes (pids 38780, 23792) printed `KILL FAILED` instead, even
> though the whole process tree was gone seconds later in both cases:
> `killTree()` in `scripts/reap-stale-batteries.mjs` takes its verdict from
> `taskkill /T`'s exit code, which is non-zero when a tree member exits
> during the sweep. That misreport of a kill that landed is the bug filed as
> [#3403](https://github.com/dudarenok-maker/Castwright/issues/3403), fix in
> PR [#3404](https://github.com/dudarenok-maker/Castwright/pull/3404). The
> `[KILLED]` output on record came from `npm run doctor -- --kill`, a
> different print site, so the push-path `KILLED` line has never been seen
> on hardware. **On the owner's decision of 2026-09-25, that push-path check
> moves to a new register row that PR #3404 adds**; E104's other bullets
> discharge here.
>
> This branch diverged from the register at 55 owed (Group A 35, Group E 10).
> Net effect of this change: 55 → 50 owed, Group A 35 → 32 (five Group-A rows
> removed — A17, A32, A105, A107, and originally A20 — then A20 and A105
> restored), Group E 10 → 8 (E103, E104 removed). `next-id` markers
> unaffected (allocate-once — none of these five discharged IDs are reused;
> A20/A105 were never freed).
>
> **Prior change: 2026-09-22, E107 ADDED** (#3263, PR
> [#3358](https://github.com/dudarenok-maker/Castwright/pull/3358), claude):
> `guard-worktree-write.mjs` stopped trusting the PreToolUse payload's `cwd`
> and now derives the subagent's own transcript from `transcript_path` +
> `agent_id`. The decision logic is measured over 715 real transcripts, but
> measured *after the fact*, on files already on disk. Three links can only be
> observed while a dispatch is running — that the derived file exists at hook
> time, that the brief is already in it at the FIRST guarded tool call, and
> that `agent_id` is populated for the wired role — and that gap is exactly
> what let two review rounds score the wrong file before pass 3 caught it.
> Reconciled against `main` at merge time: `main` stood at 54 owed after
> #3084 wave 1b's B101, and this branch adds exactly one row, so 54 → 55,
> Group E 9 → 10, Group B unchanged at 2. `next-id` bumped E107 → E108.
>
> **Prior change: 2026-09-21 (#3084 wave 1b), 53 → 54.** Row **B101** added
> (stage-runner extraction smoke — local Ollama + Gemini). Group B: 1 → 2.
> `next-id` bumped B101 → B102 in the same change. This branch diverged from
> the register at 53 owed / Group A 35; reconciled here against `main`'s
> current 53 owed / Group A 35 — net unchanged there across A25's discharge
> (below) and A110's addition (below) landing in between — so this branch's
> own work nets the entire delta: +1, Group B only. Combined: 53 → 54, Group
> A unchanged at 35, Group B 1 → 2.

> **Prior change: 2026-09-21, A110 ADDED** (#3347, PR
> [#3357](https://github.com/dudarenok-maker/Castwright/pull/3357), claude, fix-up
> round after `pr-review-gate` pass 1): the PR bumps the cold `asr` capacity-admission
> seed from a flat 400 MB to a model-tier-aware 2560 MB for any `ASR_MODEL` outside
> `tiny`/`base`/`small` (closing #3347's silent `denials_503: 0` under-admission), but
> both the adequacy of 2560 MB for a real `large-v3` cold load and the claim that the
> original squeeze now produces a real refusal are unprovable by the PR's own
> monkeypatched tests. 52 → 53 owed, Group A 34 → 35. `next-id` bumped A110 → A111 in
> the same change.

> **Prior change: 2026-09-20, A25 DISCHARGED and removed** (#3036, PR
> [#3282](https://github.com/dudarenok-maker/Castwright/pull/3282), claude): the
> row's bullet 1 (no `noCapacity` refusals on a real resident `/transcribe`) was
> already reconfirmed twice (wave 6, wave 7); bullet 2 (record what `asr.warm`'s
> learned p95 converges to) is now answered a second and third time over, on real
> CUDA hardware, with the same "cannot converge" conclusion wave 7 first reached and
> filed as [#2682](https://github.com/dudarenok-maker/Castwright/issues/2682) — this
> chain went on to try both directions #2682's filing left open (see #3036's issue
> body) and found both structurally dead on this box: child 1
> (`docs/testing/onbox-3036-results/step-1-nvml.md`) drove 1 cold + 6 warm real
> `/transcribe` calls against a resident `faster-whisper` `base`/`int8_float16` model
> and found the NVML own-process `usedGpuMemory` delta reads `None` for our own PID
> under this box's Windows WDDM driver even with hundreds of MB of live CUDA memory,
> so every warm sample is discarded before it can be recorded; child 2
> (`docs/testing/onbox-3036-results/step-2-device-delta.md`) reran the SAME
> device-wide free-VRAM delta the cold `asr` key already uses, now carrying its full
> foreign-PID/concurrent-reservation guard set, on a provably uncontended card (0 MiB
> used, no compute processes at precheck) — the cold `asr` key recorded a sample in
> the same session (`sample_count: 1`, proving the guards and the reading path are
> both alive), yet all 6 warm deltas still produced `sample_count: 0`: CTranslate2
> allocates its arena once at load and reuses it per forward, so device-wide free
> VRAM never measurably moves across a warm 2-second forward, confirming #2682's
> noise-floor theory rather than its contamination theory. Bullet 3 (foreign
> non-sidecar contamination) is answered the same way #2682 already found it to be —
> moot, since no sample survives long enough to be contaminated, now re-confirmed on
> a card known clean at precheck. This discharges the row on the same "cannot
> converge as claimed" basis the analogous E12 register row was discharged on (cited
> directly in #3036's own filing) — not a fix, a conclusive negative result reached
> via two independent real-hardware techniques. `SEED_FOOTPRINTS_MB["asr.warm"]`'s
> comment in `server/tts-sidecar/main.py` now carries this full history and states
> the 128 MB seed is authoritative, additionally protected by this PR's restored
> ceiling guard against contamination in both directions; #3036 itself stays OPEN,
> tracking the still-missing CTranslate2-side memory query or driver-level
> accounting as future scope, not this row's on-box acceptance debt.
> **Not yet done:** `docs/local-llm.md`'s footprint-table paragraph (named in this
> row's own Criteria) described the pre-this-PR optimistic expectation that
> `asr.warm` "genuinely does learn its own p95 ... once real observations
> accumulate" — now superseded by this run's conclusive negative; already corrected
> in this same PR's follow-up cleanup commit (`fd45c966`), alongside its other 🟡
> findings. This branch diverged from the register at 53 owed (Group A 35, after the
> other lane's A109/E105/E106 additions had already landed) — A25's discharge is
> this branch's only register effect: 53 → 52 owed, Group A 35 → 34. `next-id`
> markers unaffected (allocate-once — A25 retires, not reused).

> **Prior change: 2026-09-19 — two lanes touched the register the same day,
> reconciled here on merge.** This branch (chore/docs-onbox-register-decompose)
> and a separate lane's E105/E106 additions (Castwright#3249, ops-72 Part 2)
> both diverged from a common ancestor at 51 owed. Combined: **53 owed** — this
> branch's own work is owed-count-neutral (see below), the other lane's
> E105+E106 additions net +2 (51→53, Group E 7→9). `next-id` markers: Group H
> unmoved, Group E bumped E106→E107 (unaffected by this merge — inherited as-is
> from the other lane).
>
> **This branch, 2026-09-19 (claude), owed-count-neutral — both Group H rows
> NARROWED, neither discharged.** Row **H1** (kana-trigram richness gate at
> real-book scale for an all-kana Japanese manuscript): a real,
> sourced-from-Wikisource, genuinely all-kana Hyakunin Isshu fixture (50
> poems, 1,572 kana chars) now runs through `detectManuscriptLanguageFromChapters`
> in `detect-language.test.ts` and confirms the gate holds (`guiraudR` ≈
> 29.015). A pr-review-gate pass caught that this sample is real progress but
> too small to answer the row's own question — the gate can pass on a small
> sample for the same reason a synthetic one used to (finding B4's "the
> separation only appears at length"): flipping `KANA_NGRAM_SIZE` 3→2 makes
> the pre-existing finding-3(b) test go red while this new test stays green,
> proving 1,572 kana chars doesn't lock in the regression it's presented as
> locking. So H1 stays **narrowed, not discharged** — an initial pass on this
> same PR incorrectly discharged it; corrected before merge. Row **H2** (since removed from the register) (Han
> lexical-richness floor at book scale) NARROWED but stays owed — a larger
> real Han fixture (13 Analects chapters, ~2.25x the prior largest real
> sample) confirms the gate holds at that intermediate scale, but true
> book-scale (100k+ chars) remains unconfirmed. Neither `next-id` marker
> moved (no new row minted; H1's attempted discharge was corrected within this
> same round). Also this round, not owed-count-affecting:
> A6/A7 got a cross-reference sequencing note (same #3027 fix, same
> book/cast — one on-box session expected to cover both), A10's UI-surfacing
> reframing was already current, B1's criteria were re-derived against PR
> #2518 (row stays owed — criteria fix only), A23's live-view HTML was
> already in sync with the register (publish still owed to the operator),
> and E5 narrowed its DevTools-smoke-check target from 3 controls to 2
> pending [#3268](https://github.com/dudarenok-maker/Castwright/issues/3268)
> (the voice-library drag icon is confirmed structurally unreachable dead
> code from any current call site — filed as a design-pass decision per
> CLAUDE.md's incidental-findings protocol, not fixed silently).
>
> **Prior change: 2026-09-19, adding E106** (Castwright#3249, ops-72 Part 2, claude): a
> review pass on the same PR found that the POSIX SIGINT/SIGTERM/SIGHUP forwarding added
> to close a Ctrl+C-orphans-the-battery gap is unproven on this repo's primary (Windows)
> dev box — `detached`, process groups, and POSIX signal delivery semantics don't exist
> there in the shape this fix targets. 52 → 53 owed, Group E 8 → 9. `next-id` bumped
> E106 → E107 in the same change. `npm run check:onbox-register` green.
>
> **Prior change: 2026-09-18, adding E105** (Castwright#3249, ops-72 Part 2, claude): the
> `runStepProcess`/`runPipeline` async `spawn` conversion and step/pipeline time budgets
> are unit-tested (including timeout-vs-crash-retry mutation tests) against a fast
> throwaway fixture process tree, but `taskkill /T /F`'s own documented blind spot — a
> fork whose parent PID link died before `/T`'s walk reached it — needs a real, deep,
> long-lived Windows process tree (a genuine vitest fork-pool battery) to observe, the
> same way Part 3's reaper needed one for **E104**. This lands on top of the independent
> **A109** addition below (#3084 — a same-card endpoint's model yielding its card to Qwen
> VoiceDesign, owed against a design rather than shipped code): 51 → 52 owed, Group E 7 → 8,
> Group A unchanged at 35. `next-id` bumped E105 → E106 in the same change.
> `npm run check:onbox-register` green.
>
> **Prior change: 2026-09-17, adding A109** (#3084, claude): the OpenAI-compatible analyzer
> design (PR [#3245](https://github.com/dudarenok-maker/Castwright/pull/3245)) claimed that an
> existing row already covered the one hardware consequence of its wave-4 pre-pass — a same-card
> endpoint's model yielding its card to Qwen VoiceDesign. It cited a row "W3", which does not
> exist (there is no `W` group; the label was a wave number that leaked into a citation), and the
> nearest real rows — A17 (contended eviction on the default Qwen path) and A105 (base17 eviction
> guard) — are different scenarios. `check:register-citations` caught it as a nonexistent-ID
> citation. Rather than drop the claim, the debt is recorded as **A109**, minted from Group A's
> `next-id` floor; marker bumped A109 → A110 in the same change. 50 → 51 owed, Group A 34 → 35.
> **Unusually, this row is owed against a design rather than shipped code** — wave 4 is not built,
> so A109 cannot be run until it merges, and wave 4's ship PR discharges or narrows it. Recorded
> this way deliberately: the alternative was an unproven claim with nothing tracking it.

> **Prior change: 2026-09-10, adding A107** (#3086/#3101, claude): the unit-level fix for
> `/load`'s Kokoro-cold-load arbiter bypass is proven with a pure-Python threading test
> (fake Kokoro engine, no GPU); the ORIGINAL symptom — a real Kokoro `/load` racing a
> resident VoiceDesign forward on a shared-device box — still needs a real on-box re-run,
> recorded here as owed acceptance per CLAUDE.md's before-shipping step 3. Minted as
> **A107**, not A106 — this branch was cut before PR #3061 minted A106 for #3058's
> X-Device-Hint row, so the two collided; A107 is the next free id off the Group A
> `next-id` floor (allocate-once, per the register's own convention). 48 → 49 owed,
> Group A 32 → 33. `next-id` bumped A107 → A108 in the same change. This lands on top
> of every register change the parent branch had already merged (the 2-card-boot +
> Pinokio batch chain, #2950, the A34 repair-and-retest chain, #2903, PR #3061's
> X-Device-Hint A106 addition, the Mechanical batch 2 A35/A102 discharges, #2960, and
> ops-71 Part 3's E104 addition, #3047) — verified by row-ID-set diff against the true
> `git merge-base`, not this branch's own stale base. `npm run check:onbox-register` green.

> **Last change: 2026-09-09 (batch 2 step 5, claude), 49 → 47.** Rows **A35**
> (stranded VRAM after a chapter render, #2656) and **A102** (CUDA self-test on
> real ORT session detects Kokoro CPU fallback, #2582) fully discharged and
> dropped — both are retired, not reused (allocate-once). A35: batch 2 step 2's
> on-box run drove the row's own decisive diff (explicit `/unload` of Qwen Base
> 0.6B + Qwen 1.7B-Base, TTL-lapsed Whisper, `/debug/memory` re-read) to
> `allocated≈163MB`/`reserved≈271MB` on `cuda:0` — close to the established
> ~137/192MB single-model baseline (same order of magnitude, no multi-hundred-MB
> residual), the row's own "drops to near-zero" discharge condition; #2656
> closes as working-as-intended, correcting #1976/#1996's language for the
> record. A102: batch 2 step 1's on-box run confirmed all three bullets for
> real (`cuda_verified` populated on real load; the documented CUDA-self-test
> warning and `/health`/`api/info` fields on a forced CUDA→CPU fallback; no
> warning and no log line when CUDA genuinely succeeds). Six other Group A rows
> (A20, A24, A26, A27, A32, A33, A104, A105) were narrowed this same batch —
> real on-box evidence resolved most of each row's remaining bullets, but each
> keeps a genuine remainder (an unconfirmed echo mechanism, a wedged-design
> timeout never attempted, a false-positive now tracked as
> [#3118](https://github.com/dudarenok-maker/Castwright/issues/3118), an
> untouched RAM-hard-restart bullet, an audio-level dash-pause check, a
> Qwen-pin re-attempt, a driver-dependent prerequisite, and a co-residency
> regression now tracked as
> [#3086](https://github.com/dudarenok-maker/Castwright/issues/3086)) — see
> each row's own update block. Group A: 34 → 32. `next-id` markers unaffected
> (allocate-once IDs are never reused, so a drop never frees or renumbers a
> slot).

> **Last change: 2026-09-10, adding E104** (#3047, ops-71 Part 3, claude): the
> stale-battery reaper's `classify()` and its census/kill-scoping/never-blocks-push
> orchestration are unit- and mutation-tested in-PR, but `Win32_Process`
> classification against real, running processes on a real box cannot be.
> Row **E104** (since removed from the register) (renumbered from a same-`next-id` collision with #3051's own
> E103 allocation — the register's IDs allocate once, globally, so the
> second PR to land moves; #3051 landed first). 47 → 48 owed, Group E
> 6 → 7. `next-id` bumped E104 → E105 in the same change. This lands on
> top of every register change the parent branch had already merged (the
> 2-card-boot + Pinokio batch chain, #2950, the A34 repair-and-retest
> chain, #2903, PR #3061's X-Device-Hint A106 addition, and the
> Mechanical batch 2 chain's A35/A102 discharges, #2960) — verified by
> row-ID-set diff against the true `git merge-base`, not this branch's own
> stale base. `npm run check:onbox-register` green.

> **Prior change: 2026-09-09, two independent single-row changes merged together —
> net 49 → 49, Group A 34 → 34.** New row **A106** added for #3058's
> `X-Device-Hint` derive placement (PR #3061, claude), AND **A34 DISCHARGED and
> removed** (#2905, A34 repair-and-retest chain #2903/#2435, claude) — these two
> PRs branched from the same 49-owed base independently, so their deltas net to
> zero on the totals even though both are real, substantive changes; see each
> row/removal note below for what actually happened.
>
> **Prior change: 2026-09-09, A34 DISCHARGED and removed** (#2905, repair-and-retest
> chain #2903/#2435). The row's own criterion was met on a real re-analysis of
> *Заказ Коалфолла* — `cast.json` came back `oduvan` (ASCII), not `одуван`. Full
> write-up: `docs/testing/onbox-a34-results/step-4-apply-retest.md`. A34 is
> retired, not reused (allocate-once). That change landed on `main` while this
> batch was in flight, as did **A106** (#3058's `X-Device-Hint` derive
> placement, PR #3061) which ADDS a row; all three are reflected in the
> counts above.

> **Prior change: 2026-09-08 (step 9, #2954), 52 → 49.** Folded the six
> register rows discharged by the 2-card-boot + Pinokio batch chain (#2950),
> individually, per their own criteria:
> - **A2** DISCHARGED and dropped — step 9's cross-card device-steer walkthrough
>   confirmation ran for real on both cards, no OOM, no cross-card clobber, no
>   silent wrong-card fallback (`step-1-a2.md`). Group A 35 → 34.
> - **A3** NARROWED, not discharged — the 10-item checklist and task 16/16.5's
>   build+tests both passed for real, but the real-hardware trigger did not
>   reach `runAutoRevert` in production (`start.ps1` absorbs the code-43 streak
>   before Node's own supervisor sees it); row narrows to that one remaining
>   wiring gap (`step-2-a3-checklist.md`, `step-3-a3-build.md`,
>   `step-4-a3-hardware.md`). Row count unchanged.
> - **A12** NARROWED, not discharged — bullets 1/3/4 (pin-survives-respawn,
>   codec-pin placement, codec-pin-falls-back-to-cpu) confirmed for real on
>   both cards; bullet 2 (enumeration-order swap) deliberately left untouched —
>   excluded from this chain for contention risk against the box's other live
>   lanes, not a hardware gap (`step-5-a12.md`). Row count unchanged.
> - **E7** DISCHARGED and dropped — Update took `classifyVenvState`'s
>   `pip-in-place` branch (the v1.13.0→v1.15.0 span this throwaway exercised
>   crosses many releases, so `reqHash` had genuinely changed): `pip check`
>   was reproduced BROKEN at the pre-fix v1.13.0 baseline, then CLEAN
>   immediately after Update with no server ever having started — exactly
>   the `pip-in-place` branch's own documented shape. `ensureOrtMarker`'s
>   boot-time self-heal separately ran without error and ALSO reported
>   `noop` (Update's own `pip-in-place` step had already fixed the install,
>   so there was nothing left for the self-heal to do — consistent, not
>   contradictory; the self-heal's own corrective-write branch is unexercised
>   by this run and stays covered by `ort-ensure-marker.test.ts`); a fresh
>   Install confirmed the `pip-in-place` branch cleanly on a second,
>   independent throwaway; Qwen3 install confirmed no `WinError 5`
>   (`step-6-e7.md`). Group E 8 → 7.
> - **E11** DISCHARGED and dropped — a genuinely CRLF-mangled
>   `requirements/*.txt` was created from a pre-#2799 checkout, Update
>   normalized it to LF without a spurious force-reinstall (`classifyVenvState`'s
>   `noop` branch), and a subsequent fresh Install also normalized correctly
>   (`step-7-e11.md`). Group E 7 → 6.
> - **A18** item 4 alone DISCHARGED — `import torchcodec` runs clean inside the
>   nested venv `pinokio/install.js` provisions on this box, recorded as fact
>   (`step-8-a18-item4.md`); items 1/3 stay discharged from 2026-07-31, item 2
>   stays open as previously scoped. Row count unchanged (A18 stays open on
>   item 2).
>
> Net: **52 → 49** (only A2/E7/E11 leave the register outright; A3/A12/A18 stay
> open with narrower remaining scope). This lands on top of every register
> change the parent branch had already merged (fs-38, sentence-19, B2/D1/A37,
> fs-38 closeout, D-02) — verified by row-ID-set diff against the true
> `git merge-base`, not this branch's own stale base. `npm run
> check:onbox-register` green.

> **Batch step 6, 2026-09-07 (claude) — 55 → 52 owed, three rows discharged.**
> B2 (analysis language gate, real end-to-end loop confirmed including the
> dash-attribution extended-fixture case — see `onbox-batch-results/b2.md`),
> D1 (non-English ASR content-QA calibration, `qa.asr.maxWer.{es,fr,de,ru}` set
> to `0.45` from observed WER distributions across real es/fr/de/ru chapter
> renders — see `onbox-batch-results/d1.md` for why 0.45 and not each language's
> own p90), and A37 (doubled-comma collapse pause survives the fix, real
> Coqui/XTTS measurement — see `onbox-batch-results/a37.md`) all fully
> agent-confirmed and removed. Group A 36 → 35 (A37), Group B 2 → 1 (B2),
> Group D 2 → 1 (D1). A16 and A31 were re-evidenced this same batch but
> **not** discharged — both have real, agent-checkable sub-criteria that
> passed, but each also surfaced a genuinely ambiguous or not-fully-met
> sub-check that needs a human listen or a human judgment call; see their own
> rows for what remains. This lands on top of the independent E103 addition
> below (55 owed at that point; the two changes touched disjoint groups —
> Groups A/B/D here, Group E there — and never saw each other).

> **Prior change: 2026-09-06, adding E103** (#3051, ops-75 Part 4, claude):
> `scripts/wt-gc.mjs --prune`'s junction-first teardown against real worktree
> junctions cannot be proven in-PR — every automated test (the node:test suite
> and the new `wt-gc-junctions.Tests.ps1` Pester tests) runs against throwaway
> scratch fixtures, never a real worktree. 54 → 55 owed, Group E 7 → 8.
> `next-id` bumped E103 → E104 in the same change. This lands on top of the
> independent human-checkpoint step-8 discharge below (54 owed at that point;
> the two changes never saw each other — that batch removed D3/E4/E6/E8, this
> one adds E103).

> **Prior change: 2026-09-06, human-checkpoint batch step 8 (#2985), 58 → 54.**
> Folded steps 1-7's on-box evidence into the 11 rows this batch covers.
> **Four rows fully DISCHARGED and removed** (their full original criterion
> was met with real, unambiguous evidence — citing the evidence file rather
> than keeping the row per the 2026-08-22 discharge ruling):
> **D3** (Group D 3 → 2) — the re-open bound's recovered turn, voiced through
> the real Coqui/XTTS sidecar on a real Gutenberg zh corpus paragraph, passed
> three independent objective proxies (ASR, boundary-silence, voice-identity
> cosine) all unambiguous, matching the same objective-proxy methodology this
> register's own A18 precedent already accepted;
> **E4** (Group E) — a real Qwen render forced to `tts.qwen.device: "cpu"` on
> this worktree's own isolated sidecar completed twice without crashing,
> confirmed slow (RTF 5.2–6.3×) and confirmed actually running on CPU (VRAM
> untouched), exactly the row's own criterion;
> **E6** (Group E) — observation 6 (the venv-bootstrap failure path), the
> row's one remaining debt since wave 4, induced a genuine "Setup failed"
> card with the server's real error text plus a working "Try again" (fresh
> job id), via env-scoped isolation that never touched the shared, junctioned
> venv;
> **E8** (Group E) — all four bullets (direct-port revoke, forwarder 403
> naming the correct non-default port, no-control-plus-single-explanation on
> `castwright.local` at 4 devices, and the security cross-device-delete 403)
> confirmed exactly as written, run with the required non-default
> `LAN_HTTPS_PORT=9443`.
> Net: Group D 3 → 2, Group E 10 → 7 (independent of, and stacking on top of,
> the E9/E10/E101/E12 chain already folded in below — the two chains removed
> six different E rows total from the original 13: E10/E101/E12 there, E4/E6/E8
> here). This lands on top of the independent A29 discharge below (58 owed at
> that point; the two changes touched disjoint groups — Group A vs Groups D/E —
> and never saw each other). `next-id` markers unaffected (allocate-once —
> D3/E4/E6/E8 retire, not reused).
> **Seven rows narrowed in place, not discharged** (real evidence recorded,
> genuine remaining human/dev judgment named specifically) — no count
> change: **A11** (Cancel-path confirmed; audible-delta-on-approve half
> staged for a human ear, exact clips named), **A18 item 2** (marked
> BLOCKED-ACQUISITION — this dev box confirmed still static-FFmpeg, needs a
> genuinely shared-FFmpeg box), **A22** (3 of 4 bullets confirmed decisively;
> bullet 2's `characterSnapshots` artifact has a real, traced gap — a
> hyphen/underscore id mismatch — flagged for a human/dev call on whether it
> needs its own fix), **A23** (§8.7's real re-render done; embedding evidence
> for `coalfall-dragon` explicitly ambiguous and `mairin` has no numeric
> baseline at all — exact clip timestamps named for the still-owed human
> listen), **E2** (3 of 4 bullets confirmed; the real-phone mkcert-install +
> pairing bullet marked BLOCKED-ACQUISITION — needs a real phone), **E3**
> (bullets 1-2 confirmed; bullet 3's bare-LAN-IP rejection confirmed in
> practical effect but returns 401 with a different message than the row's
> literal 403-loopback wording — flagged for a human/dev call on whether
> that's an acceptable equivalent), **E5** (all three remaining touch
> controls still owed, now with real diagnostic findings: two show real
> click-through but no measurable `:active` style change under this
> session's touch method, one is structurally unreachable dead code —
> both flagged as specific follow-up questions rather than left as a bare
> "still owed"). Full evidence for all eleven rows:
> `docs/testing/onbox-human-checkpoint-results/step{1..7}-*.md`. Refs #2978,
> #2435.
>
> **Prior change: 2026-09-07 (claude), 59 → 58 — Group A 37 → 36.** Row **A29**
> (ORT marker — in-app Qwen3 install, #2192) fully discharged and dropped —
> **A29 is retired, not reused** (allocate-once, same precedent as A28/A36).
> Chain #2913 → #3020 → #3038 → #3039 → **#3040 (this pass)**: #3020 genuinely
> reproduced `WinError 5` on the in-app Qwen3 install click-through (the
> installer never stopped the sidecar before running `pip`, so `qwen-tts`'s
> transitive `onnxruntime` wheel could not replace the live sidecar's
> memory-mapped DLL); #3039/PR #3043 fixed it (`withSidecarHeld`, restructuring
> the installer to hold the sidecar down for the pip step and restore the GPU
> ONNX runtime afterward). This pass re-ran #3020's exact procedure against the
> merged fix in a fresh worktree: confirmed Qwen3-TTS genuinely absent (live
> `packageFault: "missing"` probe) after a fresh venv bootstrap + deliberate
> uninstall, clicked **Install Qwen3-TTS** for real via Playwright (genuine
> `POST /api/qwen/install` job, not the installed short-circuit), and the
> install completed cleanly — **no `WinError 5`**, `"status":"installed"`.
> Loaded Kokoro afterward and confirmed `devices.kokoro: "cuda"` from the live
> `/health` response with the model actually resident — also a fix over the
> pre-fix pass's `"cpu"` reading, apparently a side effect of PR #3043's
> ORT-restore step. Full evidence:
> `docs/testing/onbox-a29-results/step-3-post-fix-verify.md`. This lands on top
> of the independent Group C step 4 chain below (59 owed at that point; the
> two changes touched disjoint groups — Group A vs Group C — and never saw
> each other). `next-id` markers unaffected (Group A stays A106 — allocate-once
> IDs are never reused or renumbered).
>
> **Prior change: 2026-09-07, Group C step 4 (branch `docs/docs-2616-onbox-group-c`),
> 60 → 59 — Group C 4 → 3.** Folded steps 1-3's evidence (the C2/C3/C4 local batch
> run and the C1 cloud attempt, both this same session) into the register: **C4
> DISCHARGED and removed** — the guard fired correctly on every real collapse/
> coverage breach observed, stayed quiet on every healthy chapter, and every
> final per-chapter ratio landed on the healthy side of its threshold. **C2
> NARROWED further** — the structural invariant (unresolved/flagged populated
> at the right scale, no ch5 dash-opening collapse, no reproduction of #2306's
> narrator-collapse) is now confirmed live end-to-end; only the `state.json`
> persistence criterion remains, blocked on the run's own drift guard refusing
> to commit. **C1 and C3 STILL OWED, no criteria change** — C1 gained a new
> deterministic finding (`gemma-4-31b-it` is also `PROHIBITED_CONTENT`-blocked
> on this book's Chapter 1, falsifying the row's RECITATION-only premise); C3's
> named ch8/offset19 reproducer simply did not occur this run. Evidence:
> `docs/testing/onbox-wave11-group-c-results/step-{1-setup,2-c2c3c4-run,3-c1-cloud}.md`.
> This lands on top of the independent A5/A36/E12/E9-E10-E101 chain below (60
> owed at that point; the two chains touched disjoint rows — Group C vs Groups
> A/E — and never saw each other). `next-id` markers unaffected (Group C
> untouched by allocation; allocate-once IDs are never reused or renumbered).
>
> **Prior change: 2026-09-06 (claude), 61 → 60 — Group A 38 → 37.** Row **A5**
> (fs-60 XTTS per-language engine eligibility, plan 249) discharged on the box:
> bullets 1–4 PASS via a real `generation.ts` fallback-gate fix, bullet 5 N/A /
> superseded. Body row removed; the four external citations to it are annotated
> in place under "annotate, don't renumber".
>
> **Prior change: 2026-09-06 (claude), 62 → 61 — Group A 39 → 38.** Row **A36**
> (voice reassignment — a rebuilt audition centroid actually scores real audio,
> #1969/#2700) fully discharged and dropped — **A36 is retired, not reused**
> (allocate-once, same precedent as A28). The 2026-08-29 on-box run had left
> one criterion owed: a genuinely wrong voice was correctly flagged
> `voice-mismatch`/`severe` against a synthetic-only Phase B audition
> centroid, but the correctly-cast voice itself was ALSO false-flagged
> `severe` on fresh text — the pool's own 6th/10th-percentile band was too
> tight for a small (N=6), synthetic-only pool. Owner ruling 2026-09-05
> chose to widen the severity band specifically for synthetic-only pools
> (#2934). Step 1 (`fix/server-2934-a36-audition-band`, commit 7d12493f) implemented a
> separately-calibrated, wider `syntheticOnlySpread()` sigma band for that
> case, leaving the normal (real-anchor) percentile band untouched. Step 2
> (2026-09-06, same worktree) confirmed both halves for real on live
> Coqui/XTTS hardware, unmocked `scoreBook()`: the correctly assigned voice
> (`Claribel Dervla`), rendered on fresh text, scored `cosine=0.90230` →
> `inconclusive` (the false positive is gone, under the widened
> `pBand=0.91747`); a genuinely wrong voice (`Damien Black`) against the same
> synthetic-only centroid scored `cosine=0.16213` → `voice-mismatch`/`severe`
> (mismatch detection intact). Both of this row's outstanding halves now
> hold, so the row discharges in full. Full evidence:
> `docs/testing/onbox-a36-results/step-3-onbox.md`. This lands on top of the
> independent E12/E9/E10/E101 discharges below (62 owed at that point; the two
> chains touched disjoint rows and never saw each other). `next-id` unaffected
> (Group A still A106, Group E unaffected; allocate-once IDs are never reused
> or renumbered).
>
> **Prior change: 2026-09-06, discharging E12** (#2682, PR #2799 chain via #2930,
> claude): the E12 rework (#3012) added `FootprintTable.snapshot()` +
> `GET /debug/memory`'s new `footprints` block (per-key seed/learned/sample-count,
> previously unobservable from outside the process), then root-caused the 0.0 MB
> torch-CUDA-counter anomaly step 1 (#2932) had flagged and step 2's verify
> (#2931) FAILed on: `faster-whisper`'s CTranslate2 backend never routes any CUDA
> work — weights or per-forward activations — through PyTorch's caching
> allocator, so `_observed_mb()` structurally cannot see any of its activity. A
> live re-run (1 cold + 6 resident `/transcribe` calls, zero `noCapacity`
> refusals) confirmed the consequence directly: `asr.warm`'s `sample_count`
> stayed 0 through all 6 resident calls. This is a documented, evidence-backed
> "cannot converge as claimed" conclusion, discharging the row per its own
> acceptance criteria's OR branch — see
> `docs/testing/onbox-e12-results/step-1-rework-run.md`. The underlying defect
> this row tracked is still live and unfixed — #3036 tracks it now that this row
> no longer does. This merges on top of the independent E9/E10/E101 chain below
> (63 → 62 owed, Group E 11 → 10; the two changes touched disjoint rows in the
> same group and never saw each other). `next-id` markers unaffected
> (allocate-once IDs are never reused or renumbered).
>
> **Prior change: 2026-09-06 (E9/E10/E101 chain, #2948, claude), 65 → 63 —
> Group E 13 → 11.** Step 4 of the chain folded all three rows' on-box
> results: **E10** (`npm run stop` four-way discrimination, #2632/PR #2635)
> and **E101** (shared-run-dir owner-note collision, #2641/PR #2754) both
> PASSED for real (`docs/testing/onbox-e9-e10-e101-results/step-2-e10.md`,
> `step-3-e101.md`) and are fully discharged and REMOVED outright — both
> claims this register existed to prove now have real, PID-verified evidence
> and nothing is left owed on either row. **E9** is KEPT: item (2) (the
> dash-stripped re-run invariance check) is discharged — re-run against
> current `main` (`76aa7c6d`, descendant of the final fix mechanism attempt 4
> `5a60b088` plus the P1/P2 regression fixes) and the criterion **still
> fails** on `Ночной дозор`, the same real, reproducible residual gap wave
> 3/4 already characterized, not a new regression (`step-1-e9.md`). A FAIL is
> a valid, complete discharge of the *re-run debt* itself — fresh evidence is
> now on record, so item (2) no longer owes a re-run, even though its
> underlying property gap remains unfixed. Item (3) (post-D18 re-analysis)
> was explicitly out of this chain's scope and stays owed, riding Group C's
> own session. `next-id` markers unaffected (allocate-once IDs are never
> reused or renumbered).
>
> **Prior change: 2026-09-01, merging this branch's wave-10 A28 discharge with
> `main`'s independent ROCm/AMD Blocked-row addition.** This branch
> (`chore/sidecar-kokoro-cuda-path`) had discharged row **A28** below (66 → 65,
> Group A 40 → 39); `origin/main` had independently added the Blocked-section
> ROCm/AMD row (#2813, PR #2835) below (66 owed, no change — Blocked 5 → 6).
> The two changes started from the same post-#2810 state and never saw each
> other. The Blocked-row addition doesn't affect the owed count (Blocked rows
> are excluded from that arithmetic by design — see the group table above), so
> combining nets to **65 owed**, Group A **39**, Blocked **6**. `next-id`
> markers unaffected by either change (Group A stays A106 — allocate-once IDs
> are never reused, so a drop never frees or renumbers a slot, and a
> Blocked-section addition doesn't consume a live-group id).
>
> **Prior change: 2026-09-01, 66 owed (no change) — Blocked 5 → 6.** Added a new
> Blocked-section row, **ROCm/AMD admitted device-key normalisation — real GPU
> engine load, pinned/resident, and idle-eviction**
> ([#2813](https://github.com/dudarenok-maker/Castwright/issues/2813), PR
> [#2835](https://github.com/dudarenok-maker/Castwright/pull/2835)): the
> VRAM-ledger admission layer hands engines a `"rocm:N"` device key on a
> ROCm/AMD box that no torch/CTranslate2/speechbrain call understands;
> separately an operator's config-validated `"cuda:N"` pin (or a resident
> engine's own device string) could never match that same ledger's own
> `"rocm:N"`-keyed candidates; and separately again, the idle-eviction
> ladder's own card-comparison (`_same_card`) required `"cuda"` on both
> sides it compares, so it could never match a probe-native `"rocm:N"`
> target either — three seams, all fixed (`_normalise_rocm_device_key`
> forward, `_report_rocm_device_key` reverse, both reused at `_same_card`
> too) across `_resolve_torch_device`, `_ct2_kwargs`, `_spk_run_device`,
> `WhisperEngine._ensure_loaded`, `SpeakerEngine.ensure_loaded`,
> `_engine_env_pin`, `_is_resident`, and `_same_card` — but unprovable on
> this box (dual-NVIDIA, no ROCm hardware), so it lands Blocked rather than
> Group A. The pinned-device half was found and fixed in the same PR's own
> `pr-review-gate` pass 1, and the idle-eviction half in pass 2, which is
> also why the row's title and body were widened twice after first being
> added (originally covered only the unpinned crash). **66 owed** is
> unaffected — Blocked/Unconfirmed rows are excluded from that arithmetic
> by design (see the group table above).
>
> **Prior change: 2026-08-31 (wave 10, claude), 66 → 65.** Row **A28** (ORT
> marker — fresh NVIDIA bootstrap, #2192) fully discharged and dropped —
> **A28 is retired, not reused** (allocate-once). The row's long-outstanding
> third bullet (Kokoro reporting a real `CUDAExecutionProvider` on this box)
> finally passed for real, after fixing two genuine defects the prior five
> waves' investigation had narrowed down but never turned into code:
> 1. `install-ort.mjs`'s `extraRuntimeSteps` was still missing
>    `nvidia-cufft-cu12`/`nvidia-cuda-runtime-cu12` (wave-5's own validated
>    "hypothesis 2", 2026-08-23, never shipped) — added, floor-plus-cap
>    `~=11.3.3`/`~=12.8.0` matching torch's bundled DLL build line;
>    `curand` tried and confirmed unneeded, dropped (`nvjitlink` is pulled in
>    transitively by `cufft`'s own dependency tree regardless, so it was
>    never pinned directly either way).
> 2. A newly-found, DISTINCT root cause: cuDNN 9's own lazily-dlopened
>    "engine" plugin DLLs (`cudnn_engines_tensor_ir64_9.dll` etc.) are never
>    covered by `onnxruntime.preload_dlls()` (which only preloads the fixed
>    set onnxruntime itself links against) and are NOT found via
>    `os.add_dll_directory()` either — only prepending `nvidia/<pkg>/bin` to
>    the process `PATH` works. New `main._add_nvidia_dll_dirs_to_path()`,
>    wired into the same lifespan step as `_preload_ort_cuda_dlls`.
> 3. Fixing (2) surfaced a THIRD, more serious pre-existing defect before it
>    shipped: the unpinned `nvidia-cudnn-cu12~=9.0` resolved to 9.25.1.1,
>    ABI-incompatible with the cuDNN 9.19.0 torch 2.11.0+cu128 bundles —
>    loading it via `preload_dlls()`/PATH before `import torch` broke
>    Coqui/Qwen/Whisper outright on this box (`OSError: [WinError 127]`
>    loading `torch\lib\cudnn_cnn64_9.dll`). This is exactly the risk the
>    row's own "N11" note had flagged as unverified. Tightened
>    `NVIDIA_CUDNN_CONSTRAINT` to `~=9.19.0` (floor-and-cap on torch's exact
>    bundled line) — fixes torch AND keeps the Kokoro CUDA fix intact.
>
> Verified end-to-end on real hardware via the real HTTP surface (RTX 4070
> 8 GB, `cuda:0`, no `KOKORO_DEVICE` pin — the shipped default path):
> `Device probe complete: {'kokoro': 'cuda', 'coqui': 'cuda', 'qwen':
> 'cuda'}` at startup; a real `POST /synthesize` returned 192512 bytes of
> real PCM (cold 5.5s, warm 0.45s, real VRAM allocated per `nvidia-smi`);
> `/health` reports `cuda_verified: true` with no false `stale_reason`. Full
> sidecar pytest suite and full server Vitest suite (8180 tests, per `npx
> vitest list`) both green; one pre-existing, unrelated failure
> (`test_design_kokoro_exclusion.py::test_design_voice_holds_arbiter_and_evicts_resident_kokoro`)
> reproduced against unmodified `main` at the time this row was run and is
> now fixed on `main` by PR #2810, not this row's concern.
> This also newly un-blocks **A33**'s remaining bullets (2, 3, and the #2643
> negative control) — CUDA can now genuinely construct and run on this box,
> which A33's own 2026-08-27 note recorded as the reason those bullets were
> "not testable ... on this hardware it cannot, ever." Not run this round —
> A33 stays owed for those three, now newly reachable rather than
> permanently blocked; see A33's own entry. Group A: 40 → 39. `next-id`
> unaffected (still A106; allocate-once IDs are never reused, so a drop
> never frees or renumbers a slot).
>
> **Prior change: 2026-08-30, no count change.** Row **A24**'s run note (2026-08-26,
> below) filed [#2678](https://github.com/dudarenok-maker/Castwright/issues/2678) as a
> design decision owed: should the capacity-admission layer make a Base render wait for
> a resident VoiceDesign, or evict it? PR
> [#2797](https://github.com/dudarenok-maker/Castwright/pull/2797) shipped the "wait"
> choice (`withCapacityRetry`'s extended design-residency wait, qualified by
> `deviceKey`, plus the caller-abort and `qwenDesignEverLoaded`-confusion fixes found in
> its own review). The row stays live and owed: the fix is pinned by sidecar-side unit
> tests against a *simulated* health provider, not a real sidecar with genuine warm
> VoiceDesign residency, so whether the render now actually waits (rather than the
> observed `vram-spill` failure) is still unproven on real hardware. See the row body
> for the updated acceptance criteria.
>
> **Prior change: 2026-08-30, merging PR #2790's independent A105 addition
> with `main`'s independent E101 addition.** This branch
> (`fix/sidecar-2752-base17-evict-guard`) had added row **A105** (Qwen base17
> eviction guard, #2752, PR #2790 — itself already reconciled once against
> `main`'s A102/A104 IDs in an earlier merge, see the entries below); `origin/main`
> had independently added row **E101** (since removed from the register) (#2641 — port-keyed TTS owner notes, PR
> #2754). The two rows sit in different groups and different id sequences, so
> no rename was needed this time — just combining the counts. Combined: 63
> (from `main`, including E101) + 1 (this branch's A105, base17 eviction guard)
> = **64**. Group A stays 40 (this branch's A102+A104+A105); Group E becomes 11
> (main's E101). `next-id` markers: Group A at A106 (unchanged by this merge),
> Group E bumped from E101 → E102 (main's own change).
>
> **Prior change: 2026-08-30, merging PR #2790's independent A103 addition.**
> This branch (`fix/sidecar-2752-base17-evict-guard`) had added row **A103** (since removed from the register)
> (Qwen base17 eviction guard, #2752, PR #2790), minted before `origin/main`'s
> A102/A104 reconciliation below had landed — this branch's `next-id` still
> read A103 at mint time. By the time this branch merged, `main` had already
> declared A103 a permanently-unused gap (see the entry directly below) and
> moved on to A104 (analyzer GPU-split, #2367) with `next-id` at A105. Renamed
> this branch's row from A103 to **A105** (the next free id on `main`) rather
> than reopen the gap. Combined: 62 (from `main`) + 1 (this branch's A105,
> base17 eviction guard) = **63**. Group A: 39 (main's A102 + A104) + 1 (this
> branch's A105) = 40. `next-id` bumped from A105 → A106 in this merge.
>
> **Prior change: 2026-08-29 (PR #2754 review), 62 → 63**, adding row **E101** (since removed from the register)
> (#2641 — port-keyed TTS owner notes) — documents the case where two server
> instances on different ports SHARE ONE `.run/` directory, the mechanism #2641
> fixes to prevent collision. E10 already mentions port keying but covers a
> different scenario (two separate checkouts with separate `.run/` dirs, where
> collision never occurred even before the fix); E101 covers the actual shared-run
> case now locked down. `next-id: E101` bumped to `E102` in the same change.
>
> **Prior change: 2026-08-29, merging two independent A102 additions.**
> This branch had added row **A102** (since removed from the register) (analyzer GPU-split warning + expected-device
> mismatch, #2367, Castwright#2734); `origin/main` had independently added row
> **A102** (CUDA fallback self-test #2582, PR #2719). Both started from the same
> post-#2704 state. Reconciled: kept `main`'s CUDA A102; during the merge resolution
> **A103** (the next-free id) was mistakenly treated as unavailable and skipped,
> so this branch's analyzer row was allocated **A104** instead. A103 remains
> permanently unused — a gap in the numbering that allocate-once rules prevent
> from being filled later. Combined: 61 (from `main`, post-A101-discharge via PR #2739)
> + 1 (this branch's A104, analyzer GPU-split) = **62**. Group A: 38 (main's A102) + 1 (this
> branch's A104) = 39. `next-id` bumped from A103 → A105 (skipping the permanent gap) in this merge.
>
> **Prior change: 2026-08-28 (Castwright#2734), 61 → 62**, adding row **A102** (since removed from the register)
> (analyzer GPU-split warning + expected-device mismatch, #2367) — mocked
> `execFile`/nvidia-smi covers every automated test, so the real two-GPU
> split, the once-per-signature server warning, the UI row, and the
> `expectedDevice` mismatch wording all still need a genuine 2-card boot.
> Minted from Group A's `next-id` floor; marker bumped `A102` → `A103` in
> the same change.
>
> **Previous change: 2026-08-28, merging `origin/main` into `fix/sidecar-cuda-fallback-detection`.**
> Two independent branch tips reconciled: this branch had added row **A102** (since removed from the register) (CUDA
> fallback self-test #2582, PR #2719, 61 → 62); `main` had since discharged row
> **A101** (PR #2739, 61 → 60) — the two changes started from the same post-#2704
> state and never saw each other. Combined: 60 (post-A101-discharge) + 1 (A102,
> still live) = **61**. Group A likewise nets to 38 (37 + A102). `next-id: A102`
> bumped to `A103` in the same change (unaffected by A101's discharge, since IDs
> are allocated once and never reused).
> ([#2719](https://github.com/dudarenok-maker/Castwright/pull/2719))
>
> **Prior change: 2026-08-28, 61 → 62 via PR #2719**, adding row **A102** (since removed from the register) (CUDA
> fallback self-test #2582) — minted from the next-id floor; an earlier commit on
> this branch briefly mis-minted this as A38, a dangling ID reserved by
> `onbox-sitting-plan.md`, corrected before merge.
> ([#2719](https://github.com/dudarenok-maker/Castwright/pull/2719))
>
> **Prior change: 2026-08-28 (PR #2739), 61 → 60.** Row **A101** (Qwen duration golden baseline
> bless, #1994) fully discharged and dropped: measured the real per-line duration
> spread on this box (RTX 5070 Ti, `QWEN_DEVICE=cuda:1`) via a new ad-hoc script
> (`server/tts-sidecar/tests/golden/measure_qwen_duration_spread.py`), voice
> `cw_gpu_17b`, N=10 repeated syntheses per `qwen-duration-fixture.json` line.
> Observed per-line max fractional deviation from its own mean: `narrator-plain`
> 9.0% (mean 2.936s, stdev 0.143s), `numbers-and-year` 12.2% (mean 5.192s, stdev
> 0.309s), `abbreviations` 22.4% — the observed max — (mean 4.184s, stdev 0.385s),
> `quotes-and-punctuation` 13.0% (mean 3.752s, stdev 0.321s), `multi-sentence-group`
> 19.9% (mean 4.696s, stdev 0.498s). Hand-set `qwen-duration-baseline.json`'s
> `tolerance` to **0.30** (measured max 22.4% plus ~34% headroom) from this
> measurement. `_bless` (`test_qwen_duration_golden.py`) blesses the MEAN of
> `BLESS_REPS=5` repeated real syntheses per line as the reference, not a
> single draw, so the blessed value is a stable estimate of the true mean —
> matching what `tolerance` was derived to bound. Raw N=10 spread measurement
> retained at `server/tts-sidecar/tests/golden/spread-report.json`. Per this
> file's own "record what was observed, by whom, and when" policy: observed
> by Claude Code (dudarenok-maker), 2026-08-28. **A101 is retired, not
> reused** (above).
>
> **Known limitation, accepted 2026-08-28 (repo owner, ship-as-is decision).**
> Independent verification during PR #2739's review found the real duration
> distribution can drift beyond what this single on-box measurement session
> characterized: a second, separate on-box run (23 fresh syntheses, same GPU
> and voice) measured every line's fresh mean **6.8%–21% above** the
> committed `spread-report.json`'s means, all five lines shifted the same
> direction. That is between-session drift, not the within-session noise
> `tolerance`'s derivation accounted for, and it raises this opt-in check's
> spurious-failure rate above the ~2% within-session-only estimate by an
> amount that is itself session-dependent — a fixed point estimate here goes
> stale on every re-bless (review-round-3 finding: an earlier version of
> this note quoted a fixed ~3.65%/run figure computed against `entries`
> this same PR round then re-blessed). Re-derive the estimate from the
> CURRENT `qwen-duration-baseline.json` entries and `spread-report.json` if
> a precise number is needed. `tolerance` ships unchanged rather than
> widened further or re-measured across multiple sessions — see
> [#2742](https://github.com/dudarenok-maker/Castwright/issues/2742) for the
> related but distinct open design decision (assert-time averaging to
> tighten the gate's power against a real regression, which a wider
> tolerance alone would make worse, not better).
>
> **Prior change: 2026-08-27 (PR #2704), 60 → 61**, adding row **A101** (since removed from the register) (Qwen duration
> golden baseline bless, #1994) — minted from the `next-id` floor per this
> file's own allocate-once convention (above), NOT the old high-water+1 slot
> (`A38`) this row was originally cut against before that convention shipped.
> `A38` is deliberately left dangling: `onbox-sitting-plan.md` already uses
> that citation to mean something else, and re-issuing it here is exactly the
> silent-wrong-row-resolution failure mode the stable-ID design (above) was
> built to prevent. `next-id: A101` bumped to `A102` in the same change.
>
> **Prior change: 2026-08-27, 60 → 60 (no count change).** The **Blocked** section's
> two ffmpeg rows no longer carry row IDs. They had borrowed **E6** and **E8** from
> the live Group E sequence, so each of those IDs named *two* rows — one live Group
> E row and one Blocked row — and Group E renumbers underneath the Blocked section
> whenever a row is discharged, so the pairing drifted silently. Both Blocked
> headings now carry their title alone (`ops-35 ffmpeg floor`, `ops-36
> golden-assembly`), matching the section's other three rows, and the live view
> renders their `num` cells as `—`. **Cite them by title from now on** — one
> features-doc citation was re-pointed in the same change. Nothing was renumbered,
> renamed or discharged. Also added: a per-group `<!-- next-id: <Letter>101 -->`
> allocation marker, inert until the contiguity check is replaced
> ([#2629](https://github.com/dudarenok-maker/Castwright/issues/2629)) — do not
> allocate from it yet; Group A's marker carries the same caveat inline.
> ([#2634](https://github.com/dudarenok-maker/Castwright/issues/2634),
> [#2653](https://github.com/dudarenok-maker/Castwright/issues/2653))
>
> **(#2629 has since shipped: the contiguity check is gone, replaced by
> allocation-floor checks, and Group A's inline caveat comment was removed —
> every group's `next-id` marker allocates normally now.)**
>
> **Prior change: 2026-08-27, 59 → 60 via PR #2688**, adding row **A37** (since removed from the register) (#2059's
> audible effect, not yet run).
>
> **Prior change: 2026-08-27 (on-box wave 9c), 58 → 59.** One row split in two.
> **Old A34** (voice reassignment vs. persisted audition centroid, #1969/PR #2402)
> had two criteria: (1) a reassignment discards the stale old-voice reference
> rather than silently reusing it; (2) a rebuilt reference — not a failed-to-build
> flag — is what a real render produces for the new voice. Wave 9's on-box run
> (below) proved (1) but not (2): Ivo's cloned-voice sample was too short for
> `auditionCentroid()` to build a real centroid, so the run produced
> `referenceKind: "too-short"` — the row's own named failure outcome, not its
> pass condition. Criterion (1) stays discharged (below); criterion (2) is
> **not** discharged — it is split out as new row **A36** (since removed from the register), so the owed total
> returns to 59 rather than silently dropping. See A36 for the still-owed
> criteria and [#2700](https://github.com/dudarenok-maker/Castwright/issues/2700)
> for the full acceptance text.
>
> **Prior change: 2026-08-27 (on-box wave 9b), 59 → 58.** One row fully discharged and
> dropped: **old A8** (GPU residency safety + coexistence, plan 222) — owner-confirmed
> as proven, per this file's "record what was observed, by whom, and when" policy.
> Group A renumbered contiguously (old A9–A36 → A8–A35).
>
> **Prior change: 2026-08-27 (on-box wave 9), 60 → 59.** Criterion (1) above
> discharged: with the owner's explicit go-ahead, reassigned **Ivo** (the
> wave-8-identified correctly-shaped candidate: thin on in-book anchors, one
> line long enough to clear `MIN_DURATION_SEC`) from his designed voice to a
> cloned one on the real *The Coalfall Commission* book, then re-rendered
> chapter 4. All 8 of Ivo's lines came back `qa.status: 'ok'`, `reasons: []` —
> zero `voice-mismatch` flags. Traced this against `resolveCharacterReference`
> (`server/src/audio/render-integrity/aggregate.ts`) rather than trusting the
> output shape alone: before reassignment, `persisted` read
> `referenceKind: "audition"` built from the OLD voice (`cleanMean≈0.873`,
> `pSevere≈0.673`, `pBand≈0.737`). `voiceInfoByChar` population (`aggregate.ts:532`) requires all three of
> `snap.voiceEngine` truthy, `snap.resolvedVoiceName` truthy, and
> `STOCHASTIC_ENGINES.has(snap.voiceEngine)`. All three hold for Ivo: the
> reassignment named a concrete cloned Coqui/XTTS voice, so his chapter-4
> snapshot carries a resolved voice name (only omittable when no voice is
> assigned at all, per `character-snapshots.ts:73` — not this case) on an
> engine in `STOCHASTIC_ENGINES` (`aggregate.ts:91`). So `voiceInfoByChar`
> was populated for him, i.e.
> `voiceInfo` was non-null at this render, which rules out the early
> `if (!voiceInfo) return { status: 'too-short', ... }` branch (`:262-263`) that
> never attempts a rebuild. With `voiceInfo` non-null, `matchesCurrentVoice(persisted,
> voiceInfo)` against the NEW voice was therefore actually evaluated and correctly
> returned false, so the stale reference was **not** reused — it fell to a genuine
> `auditionCentroid()` rebuild attempt using the new voice, which is the exact code
> path PR #2402 added, and *that* attempt is what returned `too-short` (`:273`).
> **What this confirms:** reassignment is detected and the stale old-voice reference
> is discarded rather than silently scored against — criterion (1) above. **What
> this does NOT confirm:** criterion (2) — split to A36. Group A
> renumbered contiguously (old A35–A37 → A34–A36).
>
> **Prior change: 2026-08-27 (on-box wave 8), 61 → 60.** One row fully discharged and
> dropped: **old A34** (respawn-budget deadline timer, Scenario 2) — with a chapter's
> sidecar killed and a manually-started, unowned bare sidecar left listening on the
> TTS port, restarting the server with `SIDECAR_NEVER_ADOPT=1` produced the exact
> expected sequence: `[sidecar] UNFIT sidecar on :9180 (prod policy: spawning a fresh
> owned sidecar instead of adopting a pre-existing one) — replacing it...` followed by
> `replaced stale sidecar (killed pid=...); spawning current build.` The new sidecar
> came up owned (`.run/tts.pid` recorded its PID) and ready, with no deadline-timeout
> message (resolved in ~3.4s, well under the 5000ms ceiling) — combined with Scenario 1
> already confirmed in wave 7, both scenarios are now done. Group A renumbered
> contiguously (old A35–A38 → A34–A37). Three rows advanced without discharging (new
> numbers): **A34** (voice reassignment) — root-caused wave 7's non-scoring failure to
> `MIN_DURATION_SEC` (3.0s per-group floor), found a correctly-shaped test character
> (Ivo) but the reassignment call itself was refused by a permission gate, still owed;
> **A35** (Kokoro fallback alarm) — 3 of 5 checks confirmed (genuine fallback, API-drift
> simulation, the #2643 real-`/synthesize`-path bullet), 2 checks (contended-admission
> vs. idle-GPU-placement) not testable on this box since Kokoro's CUDA path is
> structurally broken here regardless of contention; **A37** (stranded VRAM) — a real
> post-unload diff was taken (Qwen Base 0.6B: ~1974 MB → ~137 MB allocated after
> explicit unload, consistent with CUDA-context baseline, not a leak) but only for one
> of the row's three models (Whisper/Qwen 1.7B-Base weren't concurrently resident in
> this run), so the full three-model scenario stays owed. **A36** (cast-id drift,
> renumbered from old A37) — ran a real full re-analysis of *Заказ Коалфолла*; the
> book's `cast.json` id still comes back Cyrillic, but root-caused why: the fix only
> guards a *future* corruption of an established-ASCII id, and this book's corruption
> predates the fix, so there was never a fresh retirement event for the guard to
> intercept. Did not hand-edit the real `cast.json` to force the guarded precondition —
> correctly blocked by a permission classifier, not worked around.
>
> **Prior change: 2026-08-26 (on-box wave 7), 69 → 61.** Referring to the pre-that-change
> (old) row numbers throughout — eight rows fully discharged and dropped this wave.
> Three via real on-box measurement: **old A19** (mixed Qwen+Coqui evict fails soft,
> #1893) — the outstanding pause-during-a-stalled-evict sub-bullet was exercised: a real
> pause landed within ~300ms of hitting a permanently-stalled `/unload` call, nowhere
> near the 10-minute ceiling; **old A31** (supervisor respawn survives a refused spawn,
> #2037) — the chapter completion this row's own criteria asks for was confirmed clean
> this time, in an isolated worktree with no cross-session interference; **old A43**
> (voice-design language gate, #2246) — all three design surfaces (bulk `cast/design`,
> single JSON `design-voice`, `design-voice/stream`) confirmed blocking cleanly with no
> sidecar connection when a book's language is unset, and none of the three
> false-positive when it's set. Five via explicit repo-owner confirmation of a live
> observation, per this file's own "record what was observed, by whom, and when" policy:
> **old A12** (post-synthesis audio QA gate, plan 174) — the amber "Suspect" badge on a
> deliberately degraded (near-silent/clipped/truncated) render, confirmed on both the
> Generate and Listen rows; **old A13** (per-run resource telemetry, plan 175) —
> `#/admin` → "Resource trends" confirmed showing RTF/QA/VRAM/wall-time rows with a
> sparkline that tracks RTF after a real multi-chapter run; **old A14** (Qwen VoiceDesign
> persona-prompt rewrite, plan 160, the prior "oldest debt here") — confirmed the
> rewritten pitch/purpose-clause wording changes the rendered voice on a real audition;
> **old A16** (fe-16 Qwen auto-load on a Russian book, plan 165) — confirmed the Qwen
> banner and auto-load-with-analyzer-evicted behaviour on a real Russian book; **old A17**
> (emotion-chip preview from the manuscript, plan 180/fe-31) — confirmed the audible
> delta between a designed variant and the base voice on a real sidecar. Several dangling
> cross-references into now-deleted rows were caught and rewritten inline rather than
> renumbered. Group A renumbered contiguously throughout.
>
> Also advanced without discharging (from the same wave-7 GPU session, old numbers):
> **old A33** (now A26, ASR warm-reservation) — a real measurement answered its own open
> question: the `asr.warm` learned estimate structurally can never move off its 128MB
> seed for a `base`/`int8_float16` model, filed as
> [#2682](https://github.com/dudarenok-maker/Castwright/issues/2682) (needs a design
> decision); **old A41** (now A34, respawn budget exhaustion) — Scenario 1 fully
> confirmed (monotonic refusal counter, clean exhaustion, clean recovery via `/restart`),
> Scenario 2 (deadline timer) still owed; **old A42** (now A35, voice reassignment) —
> attempted but inconclusive, the chosen test character never accrued an
> audition-reference row at all, still owed with a better test character.
>
> **Prior change: 2026-08-26 (#2656, successor to closed #1976/#1996), 68 → 69.**
> New row **A46** (since removed from the register) added — the 2026-08-25 idle-gated VRAM measurement narrowed
> the "stranded" pool to look like the Qwen Base 0.6B + Whisper resident-model
> floor, but never captured `allocated` right after an explicit unload to
> confirm that, so it can't rule out a genuine leak underneath. #1976 and
> #1996 were closed as `not planned` (superseded, not fixed) to declutter
> their accreted measurement history; #2656 carries the actual remaining
> work and this row.
>
> **Prior change: 2026-08-26 (#2584/#2570 fix, PR #2640), 67 → 68.** New row
> **A45** added — PR #2640's `stripEstablishedAsciiRewrites` fix is proven at the
> unit/route level but still owes a real re-analysis of *Заказ Коалфолла*
> against its existing `cast-id-history.json`; see
> [`cast-id-drift-onbox-acceptance.md`](cast-id-drift-onbox-acceptance.md)
> §10.2. Numbered A45, not A44 — #2647 claimed A44 for an unrelated Kokoro
> finding independently and concurrently; this row is the later of the two to
> land.
>
> **Prior change: 2026-08-26 (#2643), 67 → 67 (no count change).** **A44**'s
> own text is corrected, not discharged: #2647's fix compared this load's
> intent against `_device`, but nothing ever resolved the string `"auto"`
> into a concrete card before that comparison, so `fell_back` stayed
> structurally dead on every REAL generation path (`synthesize`, the
> `PRELOAD_KOKORO` warm path, the admission-off `/load` branch) — none of
> which ever pass a `device=` argument or need `KOKORO_DEVICE` set. #2643
> resolves `"auto"` to the concrete device the load is actually attempting
> (derived from the same provider list that builds the ORT session, so
> placement itself is unchanged) before publishing it as intent. A44's
> acceptance criteria gain a fourth bullet for this unpinned/no-admission
> path — the first two existing bullets only ever exercised an explicit
> `KOKORO_DEVICE` pin or a VRAM-ledger admission, neither of which the actual
> regression lived on.
>
> **Prior change: 2026-08-25 (#2647), 66 → 67.** Added **A44** — Kokoro's
> silent-CPU-fallback alarm (`fell_back`) was structurally dead code on every
> default install before this fix (the regression #2636 introduced); nothing
> on real hardware has yet confirmed it fires on a genuine CUDA→CPU fallback,
> stays quiet on a ledger-admitted CPU placement, or reads `unknown` (rather
> than a false `cpu`) under kokoro-onnx API drift.
>
> **Prior change: 2026-08-25 (#2632, PR #2635), 65 → 66.** Added **E10** — the
> sidecar-sweep worktree fix ships behaviour that only two live checkouts can
> prove (that `npm run stop` sweeps the RIGHT checkout's sidecar, not the
> primary's); nothing in that PR exercises `stop-app.mjs`/`.ps1` end to end
> against a real listener.
>
> Before that: 2026-08-23 (fold step, #2625), 66 → 65. One row discharged
> live (A38, "ORT marker refuses — not repairs — a clobbered venv") and
> dropped, per the owner's remove-outright ruling — the refuse-and-log branch
> fired exactly as designed against a real copy of the live sidecar venv.
> Group A renumbered contiguously (old A39–A44 → A38–A43). Evidence:
> `docs/testing/onbox-wave5-results/step-ort-b-a39.md`. Before that: wave 5,
> #2606 step 6, 69 → 66 (A27, A45, B2 discharged). Full change-by-change
> history is in this file's git log, not here — this section tracks the
> current count, not how it got here.
