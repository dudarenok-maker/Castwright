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
      'the web app, the server, and the TTS sidecar together. If the browser tab opens but stays ' +
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
      '(games, a second model), and keep only one heavy TTS model loaded — unload the analyzer ' +
      'Ollama or a second engine from the model pills. If the slowdown crept in after hours of ' +
      "generating, restart the TTS sidecar (it reclaims leaked memory). The Admin view's " +
      'Resource trends panel shows the per-chapter speed history.',
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
];
