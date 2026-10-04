import { startPilotServer } from '../../scripts/serve.mjs';

export default async function setup() {
  let existing;
  try { existing = await fetch('http://127.0.0.1:4173/demo/', { signal: AbortSignal.timeout(1000) }); }
  catch { /* No local server; start one in this process so teardown is reliable on Windows. */ }
  if (existing) {
    await existing.arrayBuffer();
    if (existing.headers.get('X-TLH-Pilot') !== '1') throw new Error('Port 4173 is occupied by another application.');
    return;
  }
  const server = await startPilotServer(4173);
  return async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
}
