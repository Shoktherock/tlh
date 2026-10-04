import { preview } from 'vite';
export default async function setup() {
  let response;
  try { response = await fetch('http://127.0.0.1:4180', { signal: AbortSignal.timeout(1000) }); } catch {}
  if (response) {
    if (!(await response.text()).includes('TLH · Import and reconcile')) throw new Error('Port 4180 is occupied by another app.');
    return;
  }
  const server = await preview({ configFile: 'tlh/vite.config.ts' });
  return async () => { server.httpServer.closeAllConnections(); await new Promise(resolve => server.httpServer.close(resolve)); };
}
