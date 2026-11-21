// Test-only preload for start-app-prod.node-guard.test.mjs (#4443). Makes the
// child look like Node 24.15.0 on Windows and turns any socket open into a loud
// marker, so the test can prove the launcher refuses BEFORE it connects.
import net from 'node:net';

Object.defineProperty(process, 'version', { value: 'v24.15.0', configurable: true });
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
// A loopback connect is the call that crashes an affected Node, so it must
// never be reached: report it and bail instead of opening a real socket.
net.connect = function patchedConnect() {
  process.stderr.write('SOCKET-OPENED\n');
  process.exit(99);
};
