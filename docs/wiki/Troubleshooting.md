# Troubleshooting

The full symptom → fix table: server/setup problems from `INSTALL.md`, plus
every in-app failure and common question from the offline Help view
(`#/help`, reached from the top-bar "?" and Account) — the same page still
works with no network at all.

## Common setup issues

### "ffmpeg not found on PATH"

The server pipes chapter PCM through ffmpeg at encode time; missing it = no audio. Confirm with `ffmpeg -version`. If the binary is installed but not on PATH, prepend its directory to PATH in your shell profile (Windows: System → Environment Variables; macOS/Linux: `~/.zshrc` / `~/.bashrc`).

### Port :8080 already in use

In production the server now **auto-shifts to the next free port** on a clash (8080→8081→…, and likewise 8443→… for HTTPS), so a start rarely fails outright on this anymore — check the startup log (or the pairing QR) for the port it actually bound. If you'd rather free :8080: either another instance of this app is running (`npm run stop:prod` then retry), or another process is bound to it. On Windows: `netstat -ano | findstr :8080` shows the PID. On POSIX: `lsof -i:8080`. Override the port for one run via `PORT=8081 npm run start:prod` (then visit `http://localhost:8081`).

### Sidecar fails to load Kokoro

The sidecar logs to `logs/server.log` (the Node server captures sidecar stdout). Most common cause: the Kokoro weights download was interrupted mid-flight. Re-running `install-kokoro.sh` / `install-kokoro.ps1` cleans up partial downloads and retries.

### Installing Coqui or Qwen fails — "Constraints cannot have extras"

**Fixed in v1.14.0.** An older build's Coqui/Qwen installer passed the sidecar's `requirements/base.txt` directly as a pip `-c` constraints file, but that file legitimately carries an extra (`uvicorn[standard]`) — which pip forbids in a constraints file, aborting the whole install with `ERROR: Constraints cannot have extras` before it even started. Update to v1.14.0 or newer and re-run the install/repair from **Admin → Model Manager**; the installer now strips extras into a sanitized constraints file first.

### GPU not detected

Sidecar will fall back to CPU and log it. **On Windows / Linux (NVIDIA):** verify `nvidia-smi` works at the OS level — driver mismatches (e.g. CUDA 11.x runtime on a 12.x driver) are the common culprit; reinstall the matching CUDA runtime from <https://developer.nvidia.com/cuda-downloads>. **On macOS (Apple Silicon):** the GPU is used automatically via Metal — no driver setup is needed, and the sidecar log should show `device=mps`. **On AMD (experimental):** if `/about` shows the engines on CPU and a `.accelerator-fallback.json` sits in the sidecar venv, the ROCm install didn't take — update your AMD driver (latest Adrenalin) and confirm your GPU is ROCm-supported, then reinstall (delete the venv and re-bootstrap). AMD support is a preview; if it won't accelerate, set `ACCELERATOR=cpu` to silence the warning, or run a supported NVIDIA/Apple machine for full speed. Force a device with `QWEN_DEVICE=cpu` (or `mps`) in `server/.env` if you need to override the auto-detection.

### "Cannot find module '../../dist/index.html'"

`npm run start:prod` checks for the pre-built frontend bundle. The release zip ships `dist/` pre-built — if you're seeing this, the extract was incomplete or you've manually deleted `dist/`. Re-extract.

### Analysis fails immediately — "Gemini … returned an empty response"

If a chapter (often **chapter 1**) fails the instant analysis starts with `Gemini <model> returned an empty response (reason=RECITATION)`, Gemini's **recitation filter** blocked the text: `gemini-*` models refuse to process source they recognise as copyrighted, and a published book's opening chapter is the classic trigger. It's deterministic — retrying the same model on the same text fails identically.

Two ways around it:

- **Stay on the cloud, switch model.** Set `GEMINI_MODEL=gemma-4-31b-it` in `server/.env` and restart — the `gemma-*` family isn't subject to the recitation filter. Trade-off: gemma is weaker and can grind on very long chapters.
- **Go fully local (most robust for copyrighted manuscripts).** Set `ANALYZER=local` in `server/.env`, run Ollama with `ollama pull qwen3.5:4b`, and restart. Local models apply no content filter at all. See [Installing Castwright](Installing-Castwright).

After editing `server/.env`, click **Try again** in the app — it resumes from the first uncached chapter.

## Failures the app can name

When a render goes wrong, Castwright names the failure instead of shrugging. Every failure it can name is listed here — what you saw, and what to do about it.

### Chapter synthesis timed out

**What you saw:** Voice synthesis timed out for this chapter — the local engine stalled (often the voice engine reclaiming memory mid-render). Skipped so the queue advances; click Retry to re-render.

**What to do:** Click Retry on this chapter. If it times out repeatedly, restart the voice engine to clear a wedged GPU state, then retry.

### Voice engine not running

**What you saw:** Local voice engine not running — start it and resume.

**What to do:** Start the voice engine (npm start launches it automatically), wait for the voice engine pill to go green, then resume the run.

### Voice engine keeps restarting

**What you saw:** The voice engine kept restarting while rendering this chapter.

**What to do:** The voice engine is likely thrashing — the host-memory leak (side-11) or too little VRAM/RAM headroom. Restart the voice engine and/or lower generation concurrency, then Retry.

### GPU out of memory (VRAM)

**What you saw:** The GPU ran out of video memory (VRAM) mid-render — too many models were resident at once.

**What to do:** Unload any models you are not generating with (the analyzer Ollama, or a second voice engine) from the model pills, then retry. On an 8 GB card keep only one heavy voice engine loaded.

**If you've turned on "Qwen codec device" (Advanced Settings → Voice engine & device):** this opt-in setting moves part of Qwen's decode work onto the GPU for a speed boost, but it noticeably raises Qwen's own VRAM footprint. On-box testing on an 8 GB card (RTX 4070 Laptop) at a real production batch size (32) measured the dedicated VRAM peak rising from ~5.2 GB (codec off) to ~7.9 GB (codec on) — even after lowering "Qwen codec chunk size" from its default (300) to 100 — with the excess spilling into Windows' much slower shared-memory GPU fallback and then poisoning the CUDA context (every request 503s until the sidecar auto-restarts). This is a real capacity limit on 8 GB cards at larger batch sizes, not a bug: if you see this, turn "Qwen codec device" back to its default (off), or try a smaller batch size before re-enabling it. See [issue #1374](https://github.com/dudarenok-maker/Castwright/issues/1374) and the [follow-up on VRAM accounting](https://github.com/dudarenok-maker/Castwright/issues/1396).

### Computer ran out of memory

**What you saw:** The voice engine was killed by the operating system — the machine ran out of host RAM.

**What to do:** Close other memory-heavy apps and retry. If it recurs, the voice engine is leaking — restart it to reset its host memory, then resume.

### Disk full

**What you saw:** The workspace volume is out of disk space — the chapter audio could not be written.

**What to do:** Free up disk space on the workspace volume (delete old exports, or move the workspace to a larger drive), then retry the chapter.

### Analyzer rate-limited

**What you saw:** Gemini TTS rate-limited — stopped run; resume later or switch to a local engine.

**What to do:** Wait for the quota window to reset (Gemini free-tier resets daily), or switch to a local engine (Kokoro / Qwen) in the engine picker, then resume.

### Analyzer not reachable

**What you saw:** The analyzer could not be reached or stopped responding — the local Ollama daemon is down, or the analyzer service returned a server error.

**What to do:** Check that Ollama is running (ollama serve), or switch the analyzer in server/.env (ANALYZER=gemini with a GEMINI_API_KEY). Then retry the chapter or resume the run.

When GEMINI_API_KEY is set, an unreachable Ollama silently retries against Gemini, so this error usually means no fallback was configured — or both engines failed.

### Gemini blocked the chapter (copyright filter)

**What you saw:** Gemini blocked this chapter — its recitation filter refused the source text. The gemini-* models reject text they recognise as copyrighted, and a published book's opening chapter is the classic trigger.

**What to do:** Switch the analyzer to a gemma-* model (set GEMINI_MODEL=gemma-4-31b-it in server/.env — the gemma family is not subject to the recitation filter) or to the local Ollama analyzer (ANALYZER=local). Restart, then click Retry.

The block is deterministic — retrying the same model on the same text fails identically, so it is not a transient error. gemma-* runs on a separate API bucket without recitation filtering; any local Ollama model (e.g. qwen3.5:4b) avoids the filter entirely and is the most robust choice for copyrighted manuscripts.

### Analyzer reply cut short

**What you saw:** The analyzer model cut its reply short — a chapter section was too large for one attribution call, even after automatic re-splitting.

**What to do:** Retry the chapter. If it recurs, lower STAGE2_CHUNK_CHAR_BUDGET in server/.env (or Advanced Settings) or switch to a stronger analyzer model.

### Analyzer daily quota exhausted

**What you saw:** The analyzer's free-tier daily quota is exhausted.

**What to do:** Switch to a different analyzer model (GEMINI_MODEL in server/.env or Advanced Settings — each model has its own daily bucket), use the local Ollama analyzer, or wait for the quota reset shown in the error.

### Chapter attribution incomplete

**What you saw:** Some lines in this chapter may be unattributed — the analyzer's answer did not cover every sentence, so the best take was kept and the chapter was flagged.

**What to do:** Click Retry on this chapter to re-run attribution. Already-attributed lines are kept; a retry usually fills the gaps.

### Gemini API key problem

**What you saw:** Gemini TTS authentication failed — check GEMINI_API_KEY.

**What to do:** Verify GEMINI_API_KEY in server/.env is set and valid, restart the server, then retry.

### Voice catalog out of sync

**What you saw:** Local voice engine rejected a speaker — the voice catalog is out of sync with the loaded model. Stop the voice engine, re-run the speaker manifest audit, and regenerate.

**What to do:** Stop the voice engine, re-run the speaker-manifest audit, then restart the voice engine and regenerate this chapter.

### GPU error (auto-recovering)

**What you saw:** Local voice engine hit a CUDA error and is auto-restarting (the CUDA context is corrupted process-wide; only a fresh Python process recovers). Wait ~10 seconds for the voice engine pill to go green again, then click Retry on this chapter. The offending text is in the voice engine log (text_preview=) — usually a stray zero-width or control char in the manuscript.

**What to do:** Wait ~10 seconds for the voice engine to respawn (the pill goes green), then click Retry. If it recurs on the same chapter, check the voice engine log text_preview= for a stray control char.

### Running on CPU (GPU acceleration unavailable)

**What you saw:** GPU acceleration is unavailable, so the voice engine is running on the CPU (slower, but it still works). Common on AMD: the GPU driver is too old, the GPU model isn’t in the supported set, or a DirectML operation isn’t supported and Kokoro fell back to CPU.

**What to do:** Update your GPU driver (AMD: the latest Adrenalin). Confirm your GPU is supported for ROCm/DirectML — some integrated/older cards are not. AMD support is an experimental preview; if it won’t accelerate, set the Accelerator to CPU in Advanced settings to silence this, or switch back to a supported NVIDIA/Apple machine for full speed.

### Voice engine not loaded yet

**What you saw:** The voice engine is not loaded yet — synthesis was requested before the model finished loading.

**What to do:** Load the engine from its model pill (or wait for the auto-load to finish — the pill turns green), then retry the chapter.

### Unrecognised error

**What you saw:** Something failed in a way the app does not recognise — the raw error message is shown in place of this line.

**What to do:** Click Retry on this chapter. If it keeps failing, check the server / voice engine logs for the full error and report it.

## GPU capacity & VRAM placement

Symptoms specific to **capacity-aware GPU placement** (`SEG_CAPACITY_ADMISSION`,
on by default; `=0` opts out) — the admission path that reserves each heavy GPU
op's own measured VRAM footprint against a card's actual free memory. See
[Advanced Settings → GPU arbitration, memory & lifecycle](Advanced-Settings#9-gpu-arbitration-memory--lifecycle)
for how it works day to day.

### 503 "no capacity" — an op won't place on a small card that should fit it

**What you saw:** A synth, model load, voice-design, or ASR/embed call
refuses with a "no capacity" error (or waits and then fails) on a card
that's otherwise idle and roomy enough for it — e.g. a Higher-quality (1.7B)
Qwen op refused on an otherwise-empty 8 GB card.

**What to do:** This was an over-conservative footprint bug (an early per-op
VRAM reading could get poisoned by an unrelated memory spike and then never
correct itself) and is fixed as of the footprint-percentile update. If you
still see it: check that **GPU VRAM reserve cap (MB)** in Advanced Settings
hasn't been pushed unusually high, and give the sidecar a few real ops on
that engine/tier — the footprint estimate is most conservative right after a
restart and relaxes to match real usage as it accumulates observations.

### `/capacity`'s reported free VRAM doesn't match nvidia-smi's free

**What you saw:** The sidecar's capacity probe (or the Device panel in Model
Manager) reports noticeably less free VRAM than `nvidia-smi` shows for the
same, idle card.

**What to do:** Expected, not a bug. Roughly 1 GB is held by the CUDA
runtime/context itself and is already excluded from what capacity-aware
placement treats as free — an idle 8 GB card can show `nvidia-smi` used
≈114 MB while the driver's own free-memory query reports ≈7068 MB free.
Placement measures against the latter, so it isn't re-subtracting the
context a second time; the gap you're seeing is the context, not a leak or a
double-counted reserve.

### "GPU is lost" / CUDA errors on an eGPU

**What you saw:** The sidecar reports a lost or errored GPU, or wedges
entirely, on a machine with an external GPU (e.g. over OcuLink).

**What to do:** An OcuLink eGPU is not hot-swappable — adding or removing it
needs a full reboot, not a cable pull; unplugging it live is a hard crash,
not a supported operation. If it drops off the CUDA bus on its own mid-run,
the CUDA context is corrupted process-wide — restart the voice engine to
recover. If it doesn't come back, reboot with the card connected.

### First concurrent burst of synth + transcribe + embed errors on a cold sidecar

**What you saw:** Firing a `/synthesize`, `/transcribe`, and `/embed` call
all at once against a **freshly started** sidecar process — before any of
those three engines has handled a single call yet — can crash one of the
calls outright.

**What to do:** Known issue, not yet fixed — unrelated to capacity
placement, it's three heavy engines racing to cold-import their model
libraries at the same moment. Let each engine warm up with one call on its
own first (one synth, one transcribe, one embed), then run them
concurrently; a retry right after the crash also succeeds once the imports
have settled.

## Common questions

### The app won't start

One command starts everything: run `npm start` from the install folder and it brings up the web app, the server, and the voice engine together. If the browser tab opens but stays blank, hard-refresh (Ctrl+Shift+R). If the terminal shows a port-in-use error, another copy is already running — close it first. On a fresh install, run `npm install` once before the first start.

### "Not ready" — what do I click?

When a voice engine or the analyzer isn't ready yet, both the Setup screen (first launch) and the Status menu (the top-bar pill, any time after) now say exactly what's missing instead of a bare "not ready" — and where a safe fix exists, a button does it for you: setting up the voice engine, installing an engine's model, or connecting the local analyzer. Model Manager still has the fuller picture (package installed, weights on disk, whether the two match) if you want to look closer.

### Voices or models are missing

Open Models (Admin → Model Manager) to see what is installed. The Kokoro voice pack installs with `server/tts-sidecar/scripts/install-kokoro.ps1` (or .sh on macOS/Linux); other engines install from the Model Manager rows. If an engine shows as installed but synthesis fails with "model not loaded", load it from its pill in the top bar and wait for it to turn green.

### What languages does Castwright perform?

English, Russian, Spanish, French, German, Chinese and Japanese today, all with the same full-cast craft — the manuscript is read in its own language, every character gets a voice that speaks it, and the cast's tone and descriptions stay written in the book's own tongue. Drop in a manuscript and Castwright detects its language the moment you import it, showing you what it found — before you commit — on the Confirm details screen. A language it can't perform yet falls back to English rather than guessing. Chinese and Japanese are the newest additions (v1.14.0) — for a CJK book, pick a capable local analyzer model, since CJK attribution leans on the model more than English does. More languages are on the way.

See [Multi-language Support](Multi-language-Support) for the detection walkthrough.

### Casting a character, but some voices aren't showing up

For a non-English book, the voice picker hides voices that don't speak the book's language — a French cast doesn't want a Spanish-only voice turning up as an option. A small note under the list says how many are hidden and why ("N hidden · can't read French"); tap "show all" to bring them back if you want to browse anyway. English books are unaffected — every voice you own is available.

### My narrator (or an "unknown" background voice) shows as already Generated on a book I've never rendered

Fixed as of v1.11.0 — update if you're still seeing this. The narrator and the small shared "unknown male/female" voice every book uses for one-line extras could, on a brand-new book, quietly borrow a status, hidden-language flag, or even a sample recording from an unrelated book's narrator, because the two happened to start from the same generic name behind the scenes. Every book's narrator and background voices now keep entirely to themselves — nothing to do on your end beyond updating.

### What does "Higher quality" mean, and should I turn it on?

Every Qwen voice can render on two models: the everyday 0.6B (fast) or the larger 1.7B — better prosody and emotional range, noticeably slower and heavier on VRAM. Pin it per character from the voice picker, for a whole book at Start Generation, for a single chapter at Regenerate, or for your whole cast in one tap from the Cast view ("Pin 1.7B quality to all Qwen cast"). It also unlocks per-line direction and the vocal reactions (gasps, sighs, laughs) — those only render on the 1.7B tier. Worth it for a book you care about; leave everyday books on the fast tier.

### A line came out silent or nearly empty (Qwen degeneracy guard)

Under heavy VRAM churn on a tight card, the Qwen voice model can very
occasionally enter a state where it runs without any error but emits
near-empty audio — a broken, near-silent sentence that would otherwise ship
unnoticed. Castwright watches for this: whenever a substantial line renders
implausibly short, it reloads the Qwen model and retries once, and if the
retry is still degenerate it recycles the voice engine and fails the request
loudly rather than shipping the bad audio. This guard is **on by default** and
needs no action — a stray silent line usually just re-renders correctly on
Retry. It lives in **Advanced Settings → Voice engine & device → "Qwen
degeneracy guard"** (a sidecar restart applies a change); the only reason to
turn it off is to isolate a suspected false-positive on unusual text, and you
should turn it straight back on afterwards. The detection thresholds
themselves are fixed and not adjustable.

### Generation is much slower than usual

The usual culprit is a crowded GPU. Check it isn't sharing the card with something heavy (games, a second model), and keep only one heavy voice engine loaded — unload the analyzer Ollama or a second engine from the model pills. Rendering on the Higher-quality (1.7B) tier is also simply slower by design — that is expected, not a fault. Castwright now watches for a voice engine that has gone quiet without crashing and restarts it on its own, so a stalled render usually recovers by itself; if it doesn't pick back up within a minute or two, restart the voice engine yourself from its pill. The Admin view's Resource trends panel shows the per-chapter speed history.

### AMD GPU — running on CPU / experimental

AMD GPU support is an experimental preview. On an AMD machine Qwen and Coqui run on ROCm, but Kokoro always runs on the CPU — DirectML cannot run the Kokoro voice model, so that is expected, not a fault. If the About panel shows the engines on CPU (with an "experimental" note) even though you have an AMD GPU, the ROCm install fell back to CPU so the app would still work. To get ROCm acceleration: update your AMD driver (Windows: the latest Adrenalin), confirm your GPU is ROCm-supported, then reinstall the voice engine (delete its .venv and re-bootstrap) — your books and designed voices are safe, they live in the workspace, not the venv. To stay on CPU and silence the warning, set the Accelerator to CPU in Advanced settings; changing the accelerator rebuilds the Python environment, so it is not instant.

### I have two graphics cards — how do I put engines on different ones?

In Advanced Configuration each voice engine has its own device pin, listed by the card's real name and how much room it has free, so a second GPU no longer sits idle. A pin survives a driver update reshuffling which card is "first" — it tracks the actual device, not a slot number. If something is off, the picker says so plainly: a card that has gone missing, an engine that quietly landed on the CPU instead of the card you chose, or a card genuinely too small for what you asked — that last one now stops cleanly with a clear message instead of struggling in the background. The analyzer's device is shown too, though it isn't yours to place there — set CUDA_VISIBLE_DEVICES in server/.env if you need to move it, which overrides every per-engine pin.

### Can I design voices without a Gemini API key?

Yes — voice design's description-writing step follows the same analyzer engine you've already chosen (Local or Gemini, in Advanced settings). Set the analyzer to Local and Castwright drafts each character's voice from a model running entirely on your machine, so a fully offline setup, or one with no cloud key, can still design a full cast from scratch. Gemini stays the default for the richest descriptions; Local is the road for a no-key or offline setup.

### Why is my character gasping, sighing, or laughing when the book doesn't say so?

Beyond the words on the page, Castwright can perform the small human sounds between them — a caught breath, a soft laugh, a sigh. It reads these in automatically as part of analysis (the "Expressive directions" option, on by default) and they come alive whenever a chapter renders on the Higher-quality (1.7B) tier — an everyday-tier performance is left exactly as it was. Turn "Expressive directions" off before you analyse a book if you would rather it stuck to the words on the page.

### Can I direct a single line myself?

Yes — every line in the Manuscript view, narration included, has a small direction chip you can open and fill in with your own words: a whispered aside, a shout, a knowing pause. It sits alongside whatever Castwright detected automatically, and a hand-written direction always wins. Like the automatic directions, a custom one only comes through on the Higher-quality (1.7B) tier — pin the character (or the chapter, at Regenerate) to that tier to hear it.

### What does it mean when a line is flagged as "out of character"?

Render-integrity QA (Advanced Configuration → QA gates, off by default) measures every rendered line against that character's own established voice and flags the ones that drift — sounding like someone else even though the words are right. It runs on the CPU by default, at no VRAM cost, so switch it on in Advanced settings if you want the extra scrutiny. It's a detector, not an auto-fix: a flagged line is worth a listen, and re-rendering the chapter is the usual next step once you have confirmed it is really off.

### Can Castwright fix who-said-what mistakes for me?

Review Script, in the Manuscript view, reads back over a chapter for the small mistakes that creep into attribution — a stray speaker tag, a line split between two people, dialogue buried in narration, an emotion that doesn't fit. It can now propose the fix directly: reassign a line to the right character (creating one on the spot if the review finds someone new), set aside a stray heading or page number that isn't really part of the story, and follow a line across a chapter break to whoever opens the next one. Accept each fix or wave it off, one at a time or all at once — and if a new character shows up, Castwright offers to design their voice right there.

### How does Castwright know a character already has a voice?

Link a character to one from an earlier book in the series — offered on the Confirm Cast screen — and they keep the voice you designed for them, no redesigning a returning character book after book. Once a real cast has carried across books, a chip appears on your library shelf tallying how many voices and how many books; open it to see the returning cast, which books each one appears in, and how steady the run has been. It only shows up once carried voices exist, so a shelf of stock voices never sees it. From that panel you can also lift a shareable card naming the voices you have designed.

### A voice engine says "Needs repair"

Open Models (Admin → Model Manager). Each engine now shows its real state — whether its Python package is installed, whether the voice weights are on disk, and whether the two match. If something is half-installed (a common outcome after the Python environment has been rebuilt) the row reads "Needs repair" and its button changes to Repair. Click Repair to reinstall just what is missing; Castwright restarts the voice engine for you when it finishes. Your books and designed voices are never touched — they live in the workspace, not the engine.

### My phone can't reach the app (LAN / HTTPS)

As of v1.13.0, a production start (`npm run start:prod` / native installer / Pinokio) already serves LAN HTTPS on `:8443` — you don't need `npm run start:lan`. If your phone still can't reach it, work down this list:

- **Is it actually on HTTPS?** If the desktop opens on `http://localhost:8080`, the LAN certificate wasn't provisioned (usually `mkcert` isn't installed). Install `mkcert` (`scoop`/`brew`/`apt install mkcert`, then `mkcert -install`) and restart — the app auto-provisions the cert on the next start and comes up on `:8443`. Pinokio installs `mkcert` for you. Once the app is up, **Admin → LAN access** also flags a missing or expired certificate and offers a one-click **Regenerate** — quicker than the manual `mkcert` dance if the cert has simply lapsed.
- **Trust the certificate on the device once** — from **Admin → LAN access** (or `npm run install:cert-mobile`), open the root-CA link/QR and install it (iOS: Settings → Profile → Install → trust; Android: Settings → Security → Install certificate).
- **Same network:** phone and desktop must be on the same LAN. Pair via the QR at the LAN-IP address (`https://<lan-ip>:8443`).
- **Want the friendly `https://castwright.local` name** (and the `:443` forwarder so you can drop the port)? Run `npm run start:lan` — those extras are opt-in and not part of the bare default.

### The app loads at castwright.local but the library won't — "Missing or invalid LAN access token"

**What you saw:** `https://castwright.local` (or the raw LAN IP, with or without `:8443`) loads the app shell fine, but the library panel shows "Couldn't load your library — Library scan failed (401): Missing or invalid LAN access token."

**Why:** LAN access is guarded by a `LAN_AUTH_TOKEN`, so every non-loopback request is required to pair first — this applies to the friendly `castwright.local`/`castwright.dev.local` hostnames and any raw LAN IP exactly the same as a phone or tablet, **even when you're typing that address into a browser on the desktop machine itself.** As of v1.13.0 that token is **auto-generated on first boot** whenever LAN is on (which is the production default), so this pairing requirement is expected, not a sign you misconfigured anything. Only `https://localhost:8443` is exempt (it's recognised as loopback and skips pairing).

**What to do:**

- **Fastest, same machine only:** open `https://localhost:8443/#/` instead — no pairing needed, same server and data.
- **To authorize an actual phone/tablet:** from a tab that's already loopback-authorized (`localhost`), go to **Admin → LAN access**, name the device, and click **Authorize a device** — this shows a pairing QR. Scan it with that device's camera and it authorizes itself. For testing from a different desktop browser tab on the same machine, the LAN Access card also displays a one-click link — "Open pairing link on castwright.local" — right next to the QR whenever the friendly hostname is confirmed reachable; clicking it opens a new tab and skips straight to the "Authorize this browser?" confirmation without needing a camera. This link only appears once the server confirms the mDNS responder and the `:443` forwarder are both up and working (falling back to QR-only if they're not yet reachable, such as under `dev:lan` where this link is unavailable). `localhost` remains the quickest same-machine option and doesn't require any of this setup.
- **Don't need LAN access at all?** Set `LAN_HTTPS=0` in `server/.env` and restart — the server drops back to plain `http://localhost:8080` on the local machine only, with no token and no pairing. (Removing just the auto-generated `LAN_AUTH_TOKEN` won't help — with LAN on, the server mints a fresh one on the next boot. Since v1.13.0 the guard is **on by default in production**, not opt-in; see [Mobile, Tablet & Companion App](Mobile-Tablet-and-Companion-App) for the full LAN-access flow.)

### Where are my books and audio on disk?

On your machine, in the open — nothing is hidden in a database. Each book lives in its own folder under the workspace directory (the castwright-workspace folder next to the install, by default): the manuscript, the cast (cast.json), per-chapter audio, and exports. Deleting a book folder removes that book; back up the workspace folder and you've backed up your whole library.

### How do I send a book to Audiobookshelf?

From the Listen view, export straight to Audiobookshelf: point it at the library folder your sync app mirrors to the server, and pick either a single chaptered M4B or an MP3 folder (with the metadata.json Audiobookshelf reads directly) — whichever your library prefers. Series, cover and metadata travel with the book either way; Audiobookshelf picks it up on its next scheduled library scan.

### Analysis keeps reloading the model, or says "GPU busy"

The analyzer stays loaded while it reads through your book, so it is not reloading between chapters. On a smaller GPU it can't share the card with a voice engine at the same time, so Castwright frees the analyzer before it loads a voice — and if you kick off generation while analysis is still running, you'll see a brief "GPU busy with analysis" note: let the analysis finish, then generate. One thing to watch — if you've pointed the two analysis passes at two different local models (Advanced settings, a per-phase analysis model), a smaller card can't hold both, so it reloads between passes and the run drags. Keep the same local model for both passes, pair one local model with a cloud one (Gemini uses no GPU at all), or run on a roomier card (12 GB and up), where both sit side by side.

### I pulled a model but it's not in the analysis-model list

The analysis-model menu lists the models you've already installed into Ollama — the built-in suggestions you pulled, plus any others you added yourself. A suggested model you haven't pulled yet won't be in this menu; install it from the Model Manager's list first (or `ollama pull <name>` in a terminal) and it joins the menu the moment the pull finishes. Reopen the menu, or hit Refresh in the Model Manager, if it hasn't appeared yet. Still missing? Check that Ollama is running and the model shows up in `ollama list`.

### I chose a model on my machine, but the analysis ran on Gemini

When your analyzer engine is set to Local and Ollama can't be reached, Castwright falls back to Gemini — if you've added a Gemini API key — so a stalled daemon doesn't stall your book. The on-machine models still show in the menu while Ollama is down, which is why a "Local" choice can land on Gemini. Want it to stop and tell you instead? Start Ollama before you analyse, or set the analyzer engine to Gemini outright.
