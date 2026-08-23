# Wave 5 step 4 — register row B2 (stage-1 cast names in the manuscript's own script)

**Issue:** #2612. **Register row:** B2 ([#2313](https://github.com/dudarenok-maker/Castwright/issues/2313), PR #2317). **Parent:** #2606 / #2435.

**VERDICT: DISCHARGED** — for the criteria this step scopes (see "Not in scope" below for what this run does *not* clear).

## What was run

- **Analyzer:** local Ollama, model `qwen36-cw-iq4-32k:latest`. Ollama was already running on this box when this run started (PID 5924 at `http://localhost:11434`); left running, untouched, on exit.
- **Server:** this worktree's own dev server, `npx tsx watch --include=.env src/index.ts`, launched detached from `C:\Claude\Projects\wt-2606-onbox-wave5\server`, `PORT=8200`. Log confirmed `workspace root: C:\Claude\Projects\wt-2606-onbox-wave5\castwright-workspace` (this worktree's own isolated workspace, not the shared `C:\AudiobookWorkspace`) and `listening on http://localhost:8200`.
- **Manuscript:** the committed fixture `server/src/__fixtures__/the-coalfall-commission.ru.md` — a real Russian short chapter ("Дело о Коалфолле," Глава первая — Стук; 552 words / 6223 bytes), per this issue's explicit instruction to use it rather than re-analysing a real book in place.

## Commands executed (real output, not summarised)

```
$ curl -s -X POST http://localhost:8200/api/import -F "file=@.../the-coalfall-commission.ru.md"
→ {"tempId":"imp_vfXrfpQnAx","candidate":{... "language":"ru","languageSupported":true,"languageFallback":false, ...}}
```
Language auto-detected as Russian by the import step itself (not forced).

```
$ curl -s -X POST http://localhost:8200/api/books -H "Content-Type: application/json" \
    -d '{"tempId":"imp_vfXrfpQnAx","author":"Unknown","title":"Дело о Коалфолле","isStandalone":true,"language":"ru"}'
→ {"bookId":"unknown__standalones__untitled","manuscriptId":"mns_A2i9pOiQOV", ... "language" confirmed ru via /api/library: "language":"ru","languageSet":true}
```

```
$ curl -s -N -X POST http://localhost:8200/api/manuscripts/mns_A2i9pOiQOV/analysis -H "Content-Type: application/json" -d '{}'
```
SSE stream started stage-1 ("Detecting characters") against the real Ollama daemon. Server log (`server-boot.log`), verbatim:

```
2026-08-23 11:41:07.774 [analysis] oduvan has 2 evidence quote(s); analyzer prompt asks for ≥3.
2026-08-23 11:41:07.774 [analysis] ren has 2 evidence quote(s); analyzer prompt asks for ≥3.
2026-08-23 11:41:07.774 [analysis] meyrin has 2 evidence quote(s); analyzer prompt asks for ≥3.
2026-08-23 11:41:07.774 [analysis] dragon has 2 evidence quote(s); analyzer prompt asks for ≥3.
2026-08-23 11:41:07.774 [analysis] unknown-man has 1 evidence quote(s); analyzer prompt asks for ≥3.
2026-08-23 11:41:07.797 [analysis] mns=mns_A2i9pOiQOV phase=0 Detected 6 characters: Narrator, Одуван, Рен, Мэйрин, Дракон, Неизвестный мужчина
2026-08-23 11:41:07.798 [analysis] mns=mns_A2i9pOiQOV phase=0 2 chapters identified in 2m 8s
```

`.audiobook/cast.json` written to the book folder in the worktree's isolated workspace. Full roster, verbatim:

| id | name | script |
|---|---|---|
| `narrator` | Narrator | — (role label, not a manuscript name) |
| `oduvan` | Одуван | Cyrillic |
| `ren` | Рен | Cyrillic |
| `meyrin` | Мэйрин | Cyrillic |
| `dragon` | Дракон | Cyrillic |
| `unknown-man` | Неизвестный мужчина | Cyrillic |

## Observation against B2's own criteria

- **Every character's `name` in the resulting `cast.json` is in Cyrillic, matching how the book's prose spells it — zero Latin transliterations.** PASS. `Одуван`, `Рен`, `Мэйрин`, `Дракон`, `Неизвестный мужчина` all came back exactly as spelled in the manuscript's own script — none romanised (no `Oduvan`, `Ren`, `Meyrin`, `Dragon`, `Neizvestny muzhchina`). `Narrator` is the one English entry, expected — it is a role label the analyzer assigns for the unattributed third-person voice, not a name drawn from the manuscript text.
- **Every `id` is still ASCII kebab-case.** PASS. `narrator`, `oduvan`, `ren`, `meyrin`, `dragon`, `unknown-man` — all ASCII, all kebab-case. No Cyrillic id (the #2584 failure mode — an established id retired *in favour of* a fresh Cyrillic id — did not reproduce here, though see "Not in scope" below for why that is not conclusive).
- **No character gained a second id / no near-duplicate pair.** PASS. 6 distinct ids, no near-duplicate spellings (nothing resembling the `brann-wire`/`berrin-wire` vs `brann-weir`/`berrin-weir` split from the wave-3 run).
- **Roster size against the recorded 13-character baseline.** N/A here — that baseline belongs to the full *Заказ Коалфолла* book the wave-3/4 runs used. This step's brief explicitly substitutes the shorter committed fixture (a single short chapter, 552 words) instead of re-analysing that real book, so there is no comparable baseline for this manuscript. Roster size for this fixture: 6 characters from 1 short chapter — plausible for the content, not compared against a prior run of this same fixture (none exists).

## Not in scope / does not supersede

- This run does **not** re-confirm or re-open [#2536](https://github.com/dudarenok-maker/Castwright/issues/2536) (fixed, wave-4) or [#2584](https://github.com/dudarenok-maker/Castwright/issues/2584) (still owed) — both are specific defects tied to the *characterId-drift re-analysis* of the real *Заказ Коалфолла* book against its existing `cast-id-history.json` (a second/third analysis pass merging into prior history). This run is a **fresh import** of a different, shorter manuscript with no prior history to merge against, so it cannot exercise the id-retirement-direction code path #2584 names. Group C's *Ночной дозор* re-analysis is out of scope per this issue and was not started.
- No TTS/GPU rendering was run. No register edit was made.

## Cleanup

Dev server (and its spawned TTS sidecar, which crash-looped harmlessly since TTS was never used) killed via its process tree after evidence was captured; port 8200 freed. Ollama daemon left running exactly as found — not started or stopped by this run.
