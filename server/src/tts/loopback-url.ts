/* The server's own loopback base URL, matching whatever listener index.ts
   started: plain http on PORT normally, https on LAN_HTTPS_PORT when LAN_HTTPS
   is set (mkcert cert). The sidecar POSTs phase progress here (AR2). */
export function serverLoopbackBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const lan = env.LAN_HTTPS != null && env.LAN_HTTPS !== '' && env.LAN_HTTPS !== '0';
  if (lan) return `https://127.0.0.1:${Number(env.LAN_HTTPS_PORT ?? 8443) || 8443}`;
  return `http://127.0.0.1:${Number(env.PORT ?? 8080) || 8080}`;
}
