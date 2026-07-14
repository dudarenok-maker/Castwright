/* fe-29 — hand-written troubleshooting topics for failures the taxonomy can't
   see (the server/sidecar never got far enough to classify anything). */

import type { CategoryId } from './help-failures';

export interface HelpTopic {
  id: string;
  title: string;
  body: string;
  category: CategoryId;
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'app-wont-start',
    category: 'setup',
    title: "The app won't start",
    body:
      'One command starts everything: run `npm start` from the install folder and it brings up ' +
      'the web app, the server, and the voice engine together. If the browser tab opens but stays ' +
      'blank, hard-refresh (Ctrl+Shift+R). If the terminal shows a port-in-use error, another ' +
      'copy is already running — close it first. On a fresh install, run `npm install` once ' +
      'before the first start.',
  },
  {
    id: 'setup-not-ready',
    category: 'setup',
    title: '"Not ready" — what do I click?',
    body:
      "When a voice engine or the analyzer isn't ready yet, both the Setup screen (first launch) " +
      "and the Status menu (the top-bar pill, any time after) now say exactly what's missing " +
      'instead of a bare "not ready" — and where a safe fix exists, a button does it for you: ' +
      "setting up the voice engine, installing an engine's model, or connecting the local " +
      'analyzer. Model Manager still has the fuller picture (package installed, weights on disk, ' +
      'whether the two match) if you want to look closer.',
  },
  {
    id: 'models-missing',
    category: 'engines',
    title: 'Voices or models are missing',
    body:
      'Open Models (Admin → Model Manager) to see what is installed. The Kokoro voice pack installs ' +
      'with `server/tts-sidecar/scripts/install-kokoro.ps1` (or .sh on macOS/Linux); other engines ' +
      'install from the Model Manager rows. If an ' +
      'engine shows as installed but synthesis fails with "model not loaded", load it from its pill ' +
      'in the top bar and wait for it to turn green.',
  },
  {
    id: 'languages-supported',
    category: 'voices',
    title: 'What languages does Castwright perform?',
    body:
      'English, Russian, Spanish, French and German today, all with the same full-cast craft — ' +
      'the manuscript is read in its own language, every character gets a voice that speaks it, ' +
      "and the cast's tone and descriptions stay written in the book's own tongue. Drop in a " +
      'manuscript and Castwright detects its language the moment you import it, showing you what ' +
      "it found — before you commit — on the Confirm details screen. A language it can't perform " +
      'yet falls back to English rather than guessing. More languages are on the way.',
  },
  {
    id: 'voices-hidden-wrong-language',
    category: 'voices',
    title: "Casting a character, but some voices aren't showing up",
    body:
      "For a non-English book, the voice picker hides voices that don't speak the book's " +
      "language — a French cast doesn't want a Spanish-only voice turning up as an option. A " +
      'small note under the list says how many are hidden and why ("N hidden · can\'t read ' +
      'French"); tap "show all" to bring them back if you want to browse anyway. English books ' +
      'are unaffected — every voice you own is available.',
  },
  {
    id: 'higher-quality-tier',
    category: 'quality',
    title: 'What does "Higher quality" mean, and should I turn it on?',
    body:
      'Every Qwen voice can render on two models: the everyday 0.6B (fast) or the larger 1.7B — ' +
      'better prosody and emotional range, noticeably slower and heavier on VRAM. Pin it per ' +
      'character from the voice picker, for a whole book at Start Generation, for a single ' +
      'chapter at Regenerate, or for your whole cast in one tap from the Cast view ("Pin 1.7B ' +
      'quality to all Qwen cast"). It also unlocks per-line direction and the vocal reactions ' +
      '(gasps, sighs, laughs) — those only render on the 1.7B tier. Worth it for a book you care ' +
      'about; leave everyday books on the fast tier.',
  },
  {
    id: 'generation-slow',
    category: 'performance',
    title: 'Generation is much slower than usual',
    body:
      "The usual culprit is a crowded GPU. Check it isn't sharing the card with something heavy " +
      '(games, a second model), and keep only one heavy voice engine loaded — unload the analyzer ' +
      'Ollama or a second engine from the model pills. Rendering on the Higher-quality (1.7B) ' +
      'tier is also simply slower by design — that is expected, not a fault. Castwright now ' +
      'watches for a voice engine that has gone quiet without crashing and restarts it on its ' +
      "own, so a stalled render usually recovers by itself; if it doesn't pick back up within a " +
      "minute or two, restart the voice engine yourself from its pill. The Admin view's Resource " +
      'trends panel shows the per-chapter speed history.',
  },
  {
    id: 'amd-gpu',
    category: 'performance',
    title: 'AMD GPU — running on CPU / experimental',
    body:
      'AMD GPU support is an experimental preview. On an AMD machine Qwen and Coqui run on ROCm, ' +
      'but Kokoro always runs on the CPU — DirectML cannot run the Kokoro voice model, so that is ' +
      'expected, not a fault. If the About panel shows the engines on CPU (with an "experimental" ' +
      'note) even though you have an AMD GPU, the ROCm install fell back to CPU so the app would ' +
      'still work. To get ROCm acceleration: update your AMD driver (Windows: the latest Adrenalin), ' +
      'confirm your GPU is ROCm-supported, then reinstall the voice engine (delete its .venv and ' +
      're-bootstrap) — your books and designed voices are safe, they live in the workspace, not the ' +
      'venv. To stay on CPU and silence the warning, set the Accelerator to CPU in Advanced ' +
      'settings; changing the accelerator rebuilds the Python environment, so it is not instant.',
  },
  {
    id: 'multi-gpu-placement',
    category: 'performance',
    title: 'I have two graphics cards — how do I put engines on different ones?',
    body:
      "In Advanced Configuration each voice engine has its own device pin, listed by the card's " +
      'real name and how much room it has free, so a second GPU no longer sits idle. A pin ' +
      'survives a driver update reshuffling which card is "first" — it tracks the actual device, ' +
      'not a slot number. If something is off, the picker says so plainly: a card that has gone ' +
      'missing, an engine that quietly landed on the CPU instead of the card you chose, or a ' +
      'card genuinely too small for what you asked — that last one now stops cleanly with a ' +
      "clear message instead of struggling in the background. The analyzer's device is shown too, " +
      "though it isn't yours to place there — set CUDA_VISIBLE_DEVICES in server/.env if you need " +
      'to move it, which overrides every per-engine pin.',
  },
  {
    id: 'design-without-cloud-key',
    category: 'voices',
    title: 'Can I design voices without a Gemini API key?',
    body:
      "Yes — voice design's description-writing step follows the same analyzer engine you've " +
      'already chosen (Local or Gemini, in Advanced settings). Set the analyzer to Local and ' +
      "Castwright drafts each character's voice from a model running entirely on your machine, so " +
      'a fully offline setup, or one with no cloud key, can still design a full cast from scratch. ' +
      'Gemini stays the default for the richest descriptions; Local is the road for a no-key or ' +
      'offline setup.',
  },
  {
    id: 'vocalizations',
    category: 'quality',
    title: "Why is my character gasping, sighing, or laughing when the book doesn't say so?",
    body:
      'Beyond the words on the page, Castwright can perform the small human sounds between them — ' +
      'a caught breath, a soft laugh, a sigh. It reads these in automatically as part of analysis ' +
      '(the "Expressive directions" option, on by default) and they come alive whenever a chapter ' +
      'renders on the Higher-quality (1.7B) tier — an everyday-tier performance is left exactly as ' +
      'it was. Turn "Expressive directions" off before you analyse a book if you would rather it ' +
      'stuck to the words on the page.',
  },
  {
    id: 'line-direction',
    category: 'quality',
    title: 'Can I direct a single line myself?',
    body:
      'Yes — every line in the Manuscript view, narration included, has a small direction chip ' +
      'you can open and fill in with your own words: a whispered aside, a shout, a knowing pause. ' +
      'It sits alongside whatever Castwright detected automatically, and a hand-written direction ' +
      'always wins. Like the automatic directions, a custom one only comes through on the ' +
      'Higher-quality (1.7B) tier — pin the character (or the chapter, at Regenerate) to that tier ' +
      'to hear it.',
  },
  {
    id: 'voice-consistency-flag',
    category: 'quality',
    title: 'What does it mean when a line is flagged as "out of character"?',
    body:
      'Render-integrity QA (Advanced Configuration → QA gates, off by default) measures every ' +
      "rendered line against that character's own established voice and flags the ones that " +
      'drift — sounding like someone else even though the words are right. It runs on the CPU by ' +
      'default, at no VRAM cost, so switch it on in Advanced settings if you want the extra ' +
      "scrutiny. It's a detector, not an auto-fix: a flagged line is worth a listen, and " +
      're-rendering the chapter is the usual next step once you have confirmed it is really off.',
  },
  {
    id: 'script-review-fixes',
    category: 'cast',
    title: 'Can Castwright fix who-said-what mistakes for me?',
    body:
      'Review Script, in the Manuscript view, reads back over a chapter for the small mistakes ' +
      'that creep into attribution — a stray speaker tag, a line split between two people, ' +
      "dialogue buried in narration, an emotion that doesn't fit. It can now propose the fix " +
      'directly: reassign a line to the right character (creating one on the spot if the review ' +
      "finds someone new), set aside a stray heading or page number that isn't really part of the " +
      'story, and follow a line across a chapter break to whoever opens the next one. Accept each ' +
      'fix or wave it off, one at a time or all at once — and if a new character shows up, ' +
      'Castwright offers to design their voice right there.',
  },
  {
    id: 'cast-carried-across-books',
    category: 'cast',
    title: 'How does Castwright know a character already has a voice?',
    body:
      'Link a character to one from an earlier book in the series — offered on the Confirm Cast ' +
      'screen — and they keep the voice you designed for them, no redesigning a returning ' +
      'character book after book. Once a real cast has carried across books, a chip appears on ' +
      'your library shelf tallying how many voices and how many books; open it to see the ' +
      'returning cast, which books each one appears in, and how steady the run has been. It only ' +
      'shows up once carried voices exist, so a shelf of stock voices never sees it. From that ' +
      'panel you can also lift a shareable card naming the voices you have designed.',
  },
  {
    id: 'engine-needs-repair',
    category: 'engines',
    title: 'A voice engine says "Needs repair"',
    body:
      'Open Models (Admin → Model Manager). Each engine now shows its real state — whether its ' +
      'Python package is installed, whether the voice weights are on disk, and whether the two ' +
      'match. If something is half-installed (a common outcome after the Python environment has ' +
      'been rebuilt) the row reads "Needs repair" and its button changes to Repair. Click Repair ' +
      'to reinstall just what is missing; Castwright restarts the voice engine for you when it ' +
      'finishes. Your books and designed voices are never touched — they live in the workspace, ' +
      'not the engine.',
  },
  {
    id: 'phone-cant-reach',
    category: 'files',
    title: "My phone can't reach the app (LAN / HTTPS)",
    body:
      'Real devices need the LAN HTTPS mode: run `npm run dev:lan` (or `npm run start:lan` for the ' +
      'production build) and open the printed address — it now reads `https://castwright.local` ' +
      '(or `castwright.dev.local` while developing) instead of a raw IP that changes every time ' +
      'your router hands out a new one. Each device must trust the local certificate once — run ' +
      '`npm run install:cert-mobile` and follow the per-OS steps it prints. Both devices must be ' +
      'on the same network.',
  },
  {
    id: 'lan-token-pairing',
    category: 'files',
    title: 'The app loads at castwright.local but the library won\'t — "Missing or invalid LAN access token"',
    body:
      'This means `LAN_AUTH_TOKEN` is set in `server/.env` — every non-loopback request then needs ' +
      'to pair first, and `castwright.local` / `castwright.dev.local` / a raw LAN IP all count as ' +
      'non-loopback, even from a browser on the desktop machine itself. Only `https://localhost:8443` ' +
      'skips pairing — the quickest fix for same-machine testing. To authorize an actual phone or ' +
      'tablet, open Admin → LAN access and click "Authorize a device" for a pairing QR, then scan it ' +
      'with that device\'s camera. For a different desktop browser tab on the same machine, the LAN Access ' +
      'card also shows a one-click "Open pairing link on castwright.local" link right next to the QR — ' +
      'clicking it opens a new tab straight to the authorization confirmation, no camera needed. This link ' +
      'only appears when the friendly hostname is confirmed reachable (not under dev:lan, where QR-only ' +
      'shows instead). If you never meant to require pairing, remove `LAN_AUTH_TOKEN` from `server/.env` ' +
      'and restart — the guard is opt-in and off by default.',
  },
  {
    id: 'where-files-live',
    category: 'files',
    title: 'Where are my books and audio on disk?',
    body:
      'On your machine, in the open — nothing is hidden in a database. Each book lives in its ' +
      'own folder under the workspace directory (the castwright-workspace folder next to the ' +
      'install, by default): the manuscript, the cast (cast.json), per-chapter audio, and ' +
      'exports. Deleting a book folder removes that book; back up the workspace folder and ' +
      "you've backed up your whole library.",
  },
  {
    id: 'audiobookshelf-export',
    category: 'files',
    title: 'How do I send a book to Audiobookshelf?',
    body:
      'From the Listen view, export straight to Audiobookshelf: point it at the library folder ' +
      'your sync app mirrors to the server, and pick either a single chaptered M4B or an MP3 ' +
      'folder (with the metadata.json Audiobookshelf reads directly) — whichever your library ' +
      'prefers. Series, cover and metadata travel with the book either way; Audiobookshelf picks ' +
      'it up on its next scheduled library scan.',
  },
  {
    id: 'caption-export',
    category: 'files',
    title: 'Can I get captions or subtitles for a book?',
    body:
      'Yes — on the Listen view, under "Or download a file", the Captions tile writes an .srt or ' +
      '.vtt file alongside the audio. Choose the granularity — line, sentence, or word — and the ' +
      'scope — the whole book or a single chapter. Line and sentence captions are read straight ' +
      "from the book's own alignment, so there's nothing to re-render; word-level timing runs the " +
      'chapter through the local Whisper model for the finer grain a demo clip wants. The file ' +
      "lands in the book's folder with the rest of your exports.",
  },
  {
    id: 'analysis-reloads-or-gpu-busy',
    category: 'analysis',
    title: 'Analysis keeps reloading the model, or says "GPU busy"',
    body:
      'The analyzer stays loaded while it reads through your book, so it is not reloading between ' +
      "chapters. On a smaller GPU it can't share the card with a voice engine at the same time, so " +
      'Castwright frees the analyzer before it loads a voice — and if you kick off generation while ' +
      'analysis is still running, you\'ll see a brief "GPU busy with analysis" note: let the analysis ' +
      "finish, then generate. One thing to watch — if you've pointed the two analysis passes at two " +
      "different local models (Advanced settings, a per-phase analysis model), a smaller card can't " +
      'hold both, so it reloads between passes and the run drags. Keep the same local model for both ' +
      'passes, pair one local model with a cloud one (Gemini uses no GPU at all), or run on a roomier ' +
      'card (12 GB and up), where both sit side by side.',
  },
  {
    id: 'ollama-model-not-in-list',
    category: 'analysis',
    title: "I pulled a model but it's not in the analysis-model list",
    body:
      "The analysis-model menu lists the models you've already installed into Ollama — the built-in " +
      "suggestions you pulled, plus any others you added yourself. A suggested model you haven't " +
      "pulled yet won't be in this menu; install it from the Model Manager's list first (or " +
      '`ollama pull <name>` in a terminal) and it joins the menu the moment the pull finishes. ' +
      "Reopen the menu, or hit Refresh in the Model Manager, if it hasn't appeared yet. Still " +
      'missing? Check that Ollama is running and the model shows up in `ollama list`.',
  },
  {
    id: 'picked-local-but-ran-on-gemini',
    category: 'analysis',
    title: 'I chose a model on my machine, but the analysis ran on Gemini',
    body:
      "When your analyzer engine is set to Local and Ollama can't be reached, Castwright falls back " +
      "to Gemini — if you've added a Gemini API key — so a stalled daemon doesn't stall your book. " +
      'The on-machine models still show in the menu while Ollama is down, which is why a "Local" ' +
      'choice can land on Gemini. Want it to stop and tell you instead? Start Ollama before you ' +
      'analyse, or set the analyzer engine to Gemini outright.',
  },
];
