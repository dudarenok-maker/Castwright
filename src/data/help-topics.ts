/* fe-29 — hand-written troubleshooting topics for failures the taxonomy can't
   see (the server/sidecar never got far enough to classify anything). */

export interface HelpTopic {
  id: string;
  title: string;
  body: string;
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'app-wont-start',
    title: "The app won't start",
    body:
      'One command starts everything: run `npm start` from the install folder and it brings up ' +
      'the web app, the server, and the voice engine together. If the browser tab opens but stays ' +
      'blank, hard-refresh (Ctrl+Shift+R). If the terminal shows a port-in-use error, another ' +
      'copy is already running — close it first. On a fresh install, run `npm install` once ' +
      'before the first start.',
  },
  {
    id: 'models-missing',
    title: 'Voices or models are missing',
    body:
      'Open Models (Admin → Model Manager) to see what is installed. The Kokoro voice pack installs ' +
      'with `server/tts-sidecar/scripts/install-kokoro.ps1` (or .sh on macOS/Linux); other engines ' +
      'install from the Model Manager rows. If an ' +
      'engine shows as installed but synthesis fails with "model not loaded", load it from its pill ' +
      'in the top bar and wait for it to turn green.',
  },
  {
    id: 'generation-slow',
    title: 'Generation is much slower than usual',
    body:
      "The usual culprit is a crowded GPU. Check it isn't sharing the card with something heavy " +
      '(games, a second model), and keep only one heavy voice engine loaded — unload the analyzer ' +
      'Ollama or a second engine from the model pills. If the slowdown crept in after hours of ' +
      "generating, restart the voice engine (it reclaims leaked memory). The Admin view's " +
      'Resource trends panel shows the per-chapter speed history.',
  },
  {
    id: 'amd-gpu',
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
    id: 'engine-needs-repair',
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
    title: "My phone can't reach the app (LAN / HTTPS)",
    body:
      'Real devices need the LAN HTTPS mode: run `npm run dev:lan` (or `npm run start:lan` for the ' +
      'production build) and open the printed https:// address. Each device must trust the local ' +
      'certificate once — run `npm run install:cert-mobile` and follow the per-OS steps it prints. ' +
      'Both devices must be on the same network.',
  },
  {
    id: 'where-files-live',
    title: 'Where are my books and audio on disk?',
    body:
      'On your machine, in the open — nothing is hidden in a database. Each book lives in its ' +
      'own folder under the workspace directory (the castwright-workspace folder next to the ' +
      'install, by default): the manuscript, the cast (cast.json), per-chapter audio, and ' +
      'exports. Deleting a book folder removes that book; back up the workspace folder and ' +
      "you've backed up your whole library.",
  },
  {
    id: 'analysis-reloads-or-gpu-busy',
    title: 'Analysis keeps reloading the model, or says "GPU busy"',
    body:
      'The analyzer stays loaded while it reads through your book, so it is not reloading between ' +
      "chapters. On a smaller GPU it can't share the card with a voice engine at the same time, so " +
      'Castwright frees the analyzer before it loads a voice — and if you kick off generation while ' +
      'analysis is still running, you\'ll see a brief "GPU busy with analysis" note: let the analysis ' +
      "finish, then generate. One thing to watch — if you've pointed the two analysis passes at two " +
      'different local models (Advanced settings, a per-phase analysis model), a smaller card can\'t ' +
      'hold both, so it reloads between passes and the run drags. Keep the same local model for both ' +
      'passes, pair one local model with a cloud one (Gemini uses no GPU at all), or run on a roomier ' +
      'card (12 GB and up), where both sit side by side.',
  },
  {
    id: 'ollama-model-not-in-list',
    title: "I pulled a model but it's not in the analysis-model list",
    body:
      "The analysis-model menu lists the models you've already installed into Ollama — the built-in " +
      'suggestions you pulled, plus any others you added yourself. A suggested model you haven\'t ' +
      'pulled yet won\'t be in this menu; install it from the Model Manager\'s list first (or ' +
      '`ollama pull <name>` in a terminal) and it joins the menu the moment the pull finishes. ' +
      "Reopen the menu, or hit Refresh in the Model Manager, if it hasn't appeared yet. Still " +
      'missing? Check that Ollama is running and the model shows up in `ollama list`.',
  },
  {
    id: 'picked-local-but-ran-on-gemini',
    title: 'I chose a model on my machine, but the analysis ran on Gemini',
    body:
      "When your analyzer engine is set to Local and Ollama can't be reached, Castwright falls back " +
      'to Gemini — if you\'ve added a Gemini API key — so a stalled daemon doesn\'t stall your book. ' +
      'The on-machine models still show in the menu while Ollama is down, which is why a "Local" ' +
      'choice can land on Gemini. Want it to stop and tell you instead? Start Ollama before you ' +
      'analyse, or set the analyzer engine to Gemini outright.',
  },
];
