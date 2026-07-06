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
  kill: () => Promise<void>;
  isAlive: () => boolean;
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
    /* detached:true takes the responder out of the parent's process group
       (POSIX setsid) / console group (Windows CREATE_NEW_PROCESS_GROUP) —
       without it, a terminal Ctrl+C fans SIGINT out to every process
       sharing that group, so the responder would die on its own the moment
       you hit Ctrl+C on start:lan, racing shutdown()'s own kill() call
       (server/src/index.ts) for which one sets killedIntentionally first.
       Losing that race made the exit handler below warn on a completely
       ordinary shutdown. windowsHide keeps this from popping a console
       window, the same combination server/src/tts/spawn-sidecar.ts already
       uses for its own server-owned child. */
    child = spawnFn(process.execPath, [scriptPath, '--name', hostname], {
      stdio: 'ignore',
      windowsHide: true,
      detached: true,
    });
  } catch (err) {
    warn(`[mdns] failed to spawn responder for ${hostname}:`, err);
    return null;
  }

  let killedIntentionally = false;
  let alive = true;

  child.once('error', (err) => {
    warn(`[mdns] responder for ${hostname} reported an error:`, err);
  });
  /* The 'error' handler above only catches a SYNCHRONOUS spawn throw (e.g.
     a bad node binary). A child that starts fine but then crashes (e.g.
     "Cannot find module" if the responder script or a dependency is
     missing) exits ASYNCHRONOUSLY with a nonzero code — without this, that
     failure is silent: the caller holds a handle to an already-dead child
     and is never told. Only killedIntentionally (an explicit kill() call —
     checked first, so it wins regardless of what exit code/signal the OS
     reports for it; Windows' `taskkill /F` reports a NONZERO code (commonly
     1) while POSIX SIGTERM reports code=null+signal=SIGTERM) skips both the
     `alive` flip and the warning below.

     `alive` flips false on ANY non-intentional exit, code 0 included —
     unlike the warn condition below, which stays gated to `code !== 0`.
     scripts/mdns-responder.mjs's only voluntary exit path reachable from
     this caller's spawn (which always passes --name) is a graceful
     multicast-bind failure, and that path uses process.exit(0) — so
     code===0 here does NOT mean "fine, still serving," it means "gave up
     and already logged its own message." Treating it as still-alive was a
     Critical bug caught by round 2 of adversarial review on the design
     spec (docs/superpowers/specs/2026-07-06-lan-pairing-friendly-hostname-link-design.md):
     it let a dead responder keep answering isFriendlyHostnameReachable()
     with "true," handing a friendlyUrl to a user with no other way to
     pair. The warn() call stays code-gated because the graceful path
     already logs its own message from inside mdns-responder.mjs itself —
     warning here too would just be a redundant second line, not a
     correctness issue. */
  child.once('exit', (code, signal) => {
    if (killedIntentionally) return;
    alive = false;
    if (code !== 0) {
      warn(
        `[mdns] responder for ${hostname} exited unexpectedly (code=${code}${signal ? `, signal=${signal}` : ''})`,
      );
    }
  });

  return {
    child,
    isAlive: () => alive,
    /* Returns a Promise that resolves once the kill attempt has genuinely
       completed, mirroring spawn-sidecar.ts's killTree() pattern — so a
       caller (server/src/index.ts's shutdown()) can await it before
       process.exit() instead of firing it and hoping. On win32 that means
       waiting for the spawned `taskkill` child's own 'exit' (successful
       cleanup, regardless of taskkill's own exit code) or 'error' (logged,
       then resolved — a failed kill attempt shouldn't crash shutdown). On
       non-win32, child.kill('SIGTERM') is already synchronous and
       fire-and-forget from Node's perspective, so we resolve right after
       calling it — no completion event to wait for without attaching an
       'exit' listener to the original responder child, which is out of
       scope here. */
    kill: () =>
      new Promise<void>((resolvePromise) => {
        killedIntentionally = true;
        const pid = child.pid;
        if (typeof pid !== 'number') {
          resolvePromise();
          return;
        }
        if (platform === 'win32') {
          try {
            const taskkill = spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], {
              stdio: 'ignore',
              windowsHide: true,
            });
            taskkill.once('exit', () => resolvePromise());
            taskkill.once('error', (err) => {
              warn(`[mdns] taskkill for ${hostname} reported an error: ${err}`);
              resolvePromise();
            });
          } catch (err) {
            warn(`[mdns] failed to spawn taskkill for ${hostname}: ${err}`);
            resolvePromise();
          }
        } else {
          child.kill('SIGTERM');
          resolvePromise();
        }
      }),
  };
}
