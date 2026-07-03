/* Friendly LAN hostnames (ops — castwright-local-hostnames spec) — the
   server-owned mDNS responder for castwright.local.

   Spawns scripts/mdns-responder.mjs as a child process, following the same
   "server owns the child, the launcher does not" pattern already used for
   the TTS sidecar (spawn-sidecar.ts) — start-app-prod.mjs spawns the server
   itself detached and exits immediately, so it can't own anything with a
   lifecycle beyond its own.

   NODE_ENV, not LAN_HTTPS, is the discriminator: dev:lan ALSO sets
   LAN_HTTPS=1 for its server leg (so its own concurrently leg can serve
   castwright.dev.local), but must NOT also get a server-spawned
   castwright.local responder — that would spin up an extra, unwanted
   process for a hostname dev:lan never advertises, one that dev:lan's own
   `concurrently` doesn't own or reap on Ctrl+C (multicast-dns binds with
   reuseAddr:true, so this is NOT a port-5353 collision — both responders
   would happily coexist; the problem is the orphaned extra process, not a
   bind error). start-app-prod.mjs sets NODE_ENV=production on the server
   child's env; the server's plain `tsx watch` dev script never does.

   scripts/mdns-responder.mjs is intentionally NOT part of the release
   manifest (scripts/build-release-zip.mjs). To be precise about what DOES
   ship: `start:lan`'s own script + start-app-prod.mjs ARE in the manifest,
   so a packaged install can technically invoke `npm run start:lan` — but
   scripts/setup-lan-certs.mjs and scripts/print-cert-install-instructions.mjs
   (the ONLY way to generate the LAN cert) are NOT shipped, so that path was
   already a dead end before this feature: server/src/index.ts's own
   existing missing-cert check (`LAN_HTTPS=1 set but cert files are missing`)
   exits the process before ever reaching the mDNS spawn call added here. A
   packaged install genuinely running start:lan is a pre-existing, unrelated
   gap this plan doesn't touch — this responder simply follows the same
   dev-checkout-only boundary its cert-generation dependency already has. */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

export interface MdnsResponderHandle {
  child: ChildProcess;
  kill: () => void;
}

/** True only for the start:lan shape (lanHttps AND NODE_ENV=production) —
    false for dev:lan's server leg (lanHttps but NODE_ENV unset/dev), which
    already gets its own castwright.dev.local responder via the concurrently
    leg in package.json and must not also get a server-spawned one. */
export function shouldSpawnMdnsResponder(
  lanHttps: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return lanHttps && env.NODE_ENV === 'production';
}

/** Spawn scripts/mdns-responder.mjs as a child process advertising `hostname`.
    Never throws — a spawn failure is logged and returns null, matching the
    responder script's own "never fatal to the caller" contract. */
export function spawnMdnsResponder(
  hostname: string,
  repoRoot: string,
  opts: {
    spawnFn?: typeof spawn;
    warn?: (...args: unknown[]) => void;
    platform?: NodeJS.Platform;
  } = {},
): MdnsResponderHandle | null {
  const { spawnFn = spawn, warn = console.warn, platform = process.platform } = opts;
  const scriptPath = resolve(repoRoot, 'scripts', 'mdns-responder.mjs');

  let child: ChildProcess;
  try {
    child = spawnFn(process.execPath, [scriptPath, '--name', hostname], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (err) {
    warn(`[mdns] failed to spawn responder for ${hostname}:`, err);
    return null;
  }

  let killedIntentionally = false;

  child.once('error', (err) => {
    warn(`[mdns] responder for ${hostname} reported an error:`, err);
  });
  /* The 'error' handler above only catches a SYNCHRONOUS spawn throw (e.g.
     a bad node binary). A child that starts fine but then crashes (e.g.
     "Cannot find module" if the responder script or a dependency is
     missing) exits ASYNCHRONOUSLY with a nonzero code — without this, that
     failure is silent: the caller holds a handle to an already-dead child
     and is never told. Three cases do NOT warn: a clean exit(0) (the
     responder's own graceful bind-failure path — see
     scripts/mdns-responder.mjs); a null code (POSIX signal termination,
     e.g. non-Windows kill() below sending SIGTERM — the 'error' handler
     above already covers spawn-time failures); and killedIntentionally
     (an explicit kill() call, regardless of what exit code the OS reports
     for it — Windows' `taskkill /F` reports a NONZERO code (commonly 1)
     for an intentional kill, unlike POSIX SIGTERM which reports null, so
     the code===null check alone isn't enough on Windows). */
  child.once('exit', (code) => {
    if (killedIntentionally) return;
    if (code !== 0 && code !== null) {
      warn(`[mdns] responder for ${hostname} exited unexpectedly (code=${code})`);
    }
  });

  return {
    child,
    kill: () => {
      killedIntentionally = true;
      const pid = child.pid;
      if (typeof pid !== 'number') return;
      if (platform === 'win32') {
        try {
          const taskkill = spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
          taskkill.on('error', (err) => {
            warn(`[mdns] taskkill for ${hostname} reported an error: ${err}`);
          });
        } catch (err) {
          warn(`[mdns] failed to spawn taskkill for ${hostname}: ${err}`);
        }
      } else {
        child.kill('SIGTERM');
      }
    },
  };
}
